import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerSessions } from '../../src/commands/sessions.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// Mirrors the conductor Session schema (docs/openapi.sdk.yaml, Sessions group).
const SESSIONS = [
  {
    id: 'sess_a',
    profile: 'support-bot',
    runtime: 'claude',
    status: 'idle',
    createdAt: '2026-07-01T00:00:00Z',
    lastUsedAt: '2026-07-01T09:00:00Z',
    runCount: 4,
    lastRunStatus: 'ok',
  },
  {
    id: 'sess_b',
    profile: 'triage',
    runtime: 'codex',
    status: 'running',
    createdAt: '2026-07-02T00:00:00Z',
    lastUsedAt: '2026-07-02T10:30:00Z',
    runCount: 1,
  },
]

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerSessions(program)
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

describe('sessions list', () => {
  it('emits the raw session array with --json and sends the default limit', async () => {
    const calls = stubFetch({ 'GET /api/sessions?limit=10': jsonResponse(SESSIONS) })
    await run(['--json', 'sessions', 'list'])
    expect(JSON.parse(stdout())).toEqual(SESSIONS)
    expect(calls[0].path).toBe('/api/sessions?limit=10')
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({ 'GET /api/sessions?limit=10': jsonResponse(SESSIONS) })
    await run(['sessions', 'list'])
    expect(stdout()).toBe(
      'sess_a\tsupport-bot\tclaude\tidle\t2026-07-01 09:00\t4\n' +
        'sess_b\ttriage\tcodex\trunning\t2026-07-02 10:30\t1\n',
    )
  })

  it('maps --agent to the exact ?profile= filter and drops non-exact profile matches', async () => {
    // The server may predate ?profile= and return an unfiltered page (here both
    // "dev" and "dev-helper"); the client-side exact filter keeps only "dev".
    const rows = [
      { ...SESSIONS[0], id: 'sess_dev', profile: 'dev' },
      { ...SESSIONS[1], id: 'sess_devh', profile: 'dev-helper' },
    ]
    const calls = stubFetch({
      'GET /api/sessions?limit=10&profile=dev': jsonResponse(rows),
    })
    await run(['--json', 'sessions', 'list', '--agent', 'dev'])
    const out = JSON.parse(stdout())
    expect(out).toHaveLength(1)
    expect(out[0].profile).toBe('dev')
    expect(calls[0].path).toBe('/api/sessions?limit=10&profile=dev')
  })

  it('--all pages through the whole set and concatenates', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ({ ...SESSIONS[0], id: `s${i}` }))
    const second = [{ ...SESSIONS[1], id: 's200' }]
    const calls = stubFetch({
      'GET /api/sessions?limit=200': jsonResponse(first, { headers: { 'X-Total-Count': '201' } }),
      'GET /api/sessions?limit=200&offset=200': jsonResponse(second, {
        headers: { 'X-Total-Count': '201' },
      }),
    })
    await run(['--json', 'sessions', 'list', '--all'])
    expect(JSON.parse(stdout())).toHaveLength(201)
    expect(calls.map((c) => c.path)).toEqual([
      '/api/sessions?limit=200',
      '/api/sessions?limit=200&offset=200',
    ])
  })

  it('rejects --all combined with --limit as a usage error', async () => {
    const calls = stubFetch({})
    await expect(run(['sessions', 'list', '--all', '--limit', '10'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('forwards --limit and --offset to the server', async () => {
    const calls = stubFetch({
      'GET /api/sessions?limit=1&offset=1': jsonResponse([SESSIONS[1]]),
    })
    await run(['--json', 'sessions', 'list', '--limit', '1', '--offset', '1'])
    expect(JSON.parse(stdout())).toHaveLength(1)
    expect(calls[0].path).toBe('/api/sessions?limit=1&offset=1')
  })

  it('shows the "Showing X of Y" hint on stderr when the server has more', async () => {
    stubFetch({
      'GET /api/sessions?limit=10': jsonResponse([SESSIONS[0]], {
        headers: { 'X-Total-Count': '12' },
      }),
    })
    await run(['sessions', 'list'])
    expect(stdout()).toBe('sess_a\tsupport-bot\tclaude\tidle\t2026-07-01 09:00\t4\n')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 12')
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({
      'GET /api/sessions?limit=10': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['sessions', 'list'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('sessions get', () => {
  it('includes recent runs in the --json detail', async () => {
    const runs = [
      {
        id: 'run_1',
        subTask: { id: 't1', profile: 'support-bot', sessionId: 'sess_a', title: 'x' },
        status: 'ok',
        startedAt: '2026-07-01T08:00:00Z',
        finishedAt: '2026-07-01T08:00:30Z',
      },
    ]
    stubFetch({
      'GET /api/sessions/sess_a': jsonResponse(SESSIONS[0]),
      'GET /api/sessions/sess_a/runs': jsonResponse(runs),
    })
    await run(['--json', 'sessions', 'get', 'sess_a'])
    const out = JSON.parse(stdout())
    expect(out.id).toBe('sess_a')
    expect(out.runs).toEqual(runs)
  })

  it('degrades to an empty runs list when the runs endpoint fails', async () => {
    stubFetch({
      'GET /api/sessions/sess_a': jsonResponse(SESSIONS[0]),
      'GET /api/sessions/sess_a/runs': jsonResponse({ error: 'boom' }, { status: 500 }),
    })
    await run(['--json', 'sessions', 'get', 'sess_a'])
    expect(JSON.parse(stdout()).runs).toEqual([])
  })

  it('prints field rows in plain mode', async () => {
    stubFetch({
      'GET /api/sessions/sess_a': jsonResponse(SESSIONS[0]),
      'GET /api/sessions/sess_a/runs': jsonResponse([]),
    })
    await run(['sessions', 'get', 'sess_a'])
    expect(stdout()).toContain('profile\tsupport-bot')
    expect(stdout()).toContain('runCount\t4')
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/sessions/nope': jsonResponse({ error: 'unknown_session' }, { status: 404 }),
    })
    await expect(run(['sessions', 'get', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})
