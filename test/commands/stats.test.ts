import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerStats } from '../../src/commands/stats.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// Mirrors agent-runtime/runtime/httpapi/stats.go statsSummaryDTO (:30).
const SUMMARY = {
  window: '24h',
  since: '2026-07-04T00:00:00Z',
  until: '2026-07-05T00:00:00Z',
  totals: {
    agents: 3,
    sessions: 5,
    liveSessions: 2,
    runs: 10,
    runningRuns: 1,
    failedRuns: 2,
    cancelledRuns: 0,
    tokens: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreateTokens: 0 },
    errorRate: 0.2,
    p95RunDurationMs: 4200,
  },
  sessionStatusCounts: { idle: 3, running: 1, errored: 1, shutdown: 0 },
  runStatusCounts: { running: 1, ok: 7, error: 2, cancelled: 0 },
  runnerPool: { available: true, runners: 2, healthyRunners: 1, activeSessions: 3 },
}

// Mirrors statsAgentsResponseDTO (:64) with statsAgentDTO rows (:48).
const AGENTS = {
  window: '24h',
  since: '2026-07-04T00:00:00Z',
  until: '2026-07-05T00:00:00Z',
  total: 2,
  limit: 50,
  offset: 0,
  sort: 'last_activity_desc',
  agents: [
    {
      name: 'support-bot',
      runtime: 'claude',
      sessions: 3,
      liveSessions: 2,
      runningSessions: 1,
      erroredSessions: 0,
      runs: 7,
      runningRuns: 1,
      failedRuns: 0,
      cancelledRuns: 0,
      tokens: { inputTokens: 800, outputTokens: 400 },
      lastActivityAt: '2026-07-05T09:30:00Z',
      p95RunDurationMs: 3000,
    },
    {
      name: 'triage',
      runtime: 'codex',
      sessions: 2,
      liveSessions: 0,
      runningSessions: 0,
      erroredSessions: 1,
      runs: 3,
      runningRuns: 0,
      failedRuns: 2,
      cancelledRuns: 0,
      tokens: { inputTokens: 200, outputTokens: 100 },
      lastActivityAt: '2026-07-05T08:00:00Z',
      p95RunDurationMs: 5000,
    },
  ],
}

// Mirrors statsHotspotsDTO (:105) with statsHotspotDTO rows (:96).
const HOTSPOTS = {
  window: '24h',
  since: '2026-07-04T00:00:00Z',
  until: '2026-07-05T00:00:00Z',
  tokenConsumers: [
    { kind: 'agent', name: 'support-bot', runtime: 'claude', value: 1200, tokens: { inputTokens: 800, outputTokens: 400 } },
  ],
  failingAgents: [{ kind: 'agent', name: 'triage', runtime: 'codex', value: 3 }],
  busyRunners: [{ kind: 'runner', name: 'a1b2c3', value: 2 }],
  longSessions: [{ kind: 'session', name: 'sess_x', runtime: 'claude', value: 45 }],
}

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerStats(program)
  await program.parseAsync(args, { from: 'user' })
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  delete process.env.ORCA_API_KEY
  delete process.env.ORCA_API_URL
  await saveConfig({
    currentContext: 'default',
    contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .join('')
}

describe('stats (summary) --json', () => {
  it('composes summary, agents, and hotspots into one payload', async () => {
    stubFetch({
      'GET /api/stats/summary?window=24h': jsonResponse(SUMMARY),
      'GET /api/stats/agents?window=24h': jsonResponse(AGENTS),
      'GET /api/stats/hotspots?window=24h': jsonResponse(HOTSPOTS),
    })
    await run(['--json', 'stats'])
    expect(JSON.parse(stdout())).toEqual({
      window: '24h',
      summary: SUMMARY,
      agents: AGENTS.agents,
      hotspots: HOTSPOTS,
    })
  })

  it('degrades agents to [] and hotspots to null when those endpoints fail', async () => {
    stubFetch({
      'GET /api/stats/summary?window=24h': jsonResponse(SUMMARY),
      'GET /api/stats/agents?window=24h': jsonResponse({ error: 'boom' }, { status: 500 }),
      'GET /api/stats/hotspots?window=24h': jsonResponse({ error: 'boom' }, { status: 500 }),
    })
    await run(['--json', 'stats'])
    const out = JSON.parse(stdout())
    expect(out.agents).toEqual([])
    expect(out.hotspots).toBeNull()
  })
})

describe('stats (summary) plain mode', () => {
  it('emits single-shape key/value totals and does not fetch agents/hotspots', async () => {
    const calls = stubFetch({
      'GET /api/stats/summary?window=24h': jsonResponse(SUMMARY),
    })
    await run(['stats'])
    // Only the summary endpoint is hit in plain mode.
    expect(calls.map((c) => c.path)).toEqual(['/api/stats/summary?window=24h'])
    const out = stdout()
    expect(out).toContain('agents\t3')
    expect(out).toContain('runs\t10')
    expect(out).toContain('failedRuns\t2')
    expect(out).toContain('tokens\t1700')
    expect(out).toContain('healthyRunners\t1')
  })
})

describe('stats windowing', () => {
  it('passes --window through to every stats endpoint', async () => {
    const calls = stubFetch({
      'GET /api/stats/summary?window=7d': jsonResponse(SUMMARY),
      'GET /api/stats/agents?window=7d': jsonResponse(AGENTS),
      'GET /api/stats/hotspots?window=7d': jsonResponse(HOTSPOTS),
    })
    await run(['--json', 'stats', '--window', '7d'])
    expect(calls.every((c) => c.path.includes('window=7d'))).toBe(true)
  })

  it('defaults the window to 24h', async () => {
    const calls = stubFetch({ 'GET /api/stats/summary?window=24h': jsonResponse(SUMMARY) })
    await run(['stats'])
    expect(calls[0].path).toBe('/api/stats/summary?window=24h')
  })
})

describe('stats agents', () => {
  it('emits the raw agents response with --json', async () => {
    stubFetch({ 'GET /api/stats/agents?window=24h': jsonResponse(AGENTS) })
    await run(['--json', 'stats', 'agents'])
    expect(JSON.parse(stdout())).toEqual(AGENTS)
  })

  it('prints one tab-separated row per agent in plain mode', async () => {
    stubFetch({ 'GET /api/stats/agents?window=24h': jsonResponse(AGENTS) })
    await run(['stats', 'agents'])
    expect(stdout()).toBe(
      'support-bot\tclaude\t7\t0\t1200\t2026-07-05 09:30\n' +
        'triage\tcodex\t3\t2\t300\t2026-07-05 08:00\n',
    )
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({
      'GET /api/stats/agents?window=24h': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['stats', 'agents'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('stats hotspots', () => {
  it('emits the raw hotspots payload with --json', async () => {
    stubFetch({ 'GET /api/stats/hotspots?window=24h': jsonResponse(HOTSPOTS) })
    await run(['--json', 'stats', 'hotspots'])
    expect(JSON.parse(stdout())).toEqual(HOTSPOTS)
  })

  it('flattens every hotspot list into labelled rows in plain mode', async () => {
    stubFetch({ 'GET /api/stats/hotspots?window=24h': jsonResponse(HOTSPOTS) })
    await run(['stats', 'hotspots'])
    expect(stdout()).toBe(
      'tokenConsumers\tagent\tsupport-bot\t1200\n' +
        'failingAgents\tagent\ttriage\t3\n' +
        'busyRunners\trunner\ta1b2c3\t2\n' +
        'longSessions\tsession\tsess_x\t45\n',
    )
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/stats/hotspots?window=24h': jsonResponse({ error: 'nope' }, { status: 404 }),
    })
    await expect(run(['stats', 'hotspots'])).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })
})
