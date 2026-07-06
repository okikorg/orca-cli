import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerMemory } from '../../src/commands/memory.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// Mirrors agent-runtime/types/memory.go (AgentMemory) + httpapi/memory.go.
const MEM_A = {
  id: 'mem_1',
  profileName: 'support',
  rawInput: 'user likes dark mode',
  processedContent: 'prefers dark mode',
  summary: 'prefers dark mode',
  category: 'preference',
  source: 'explicit',
  confidence: 0.9,
  createdAt: '2026-07-01T09:00:00Z',
  lastAccessedAt: '2026-07-02T10:00:00Z',
  accessCount: 3,
  stalenessScore: 0.1,
  isActive: true,
  version: 1,
}
const MEM_B = {
  ...MEM_A,
  id: 'mem_2',
  profileName: 'triage',
  summary: 'escalate billing issues',
  category: 'behavior',
  confidence: 0.75,
  createdAt: '2026-07-03T08:00:00Z',
}

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerMemory(program)
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

describe('memory list', () => {
  it('emits the raw memories array with --json', async () => {
    stubFetch({
      'GET /api/profiles/support/memories': jsonResponse({
        profile: 'support',
        total: 1,
        memories: [MEM_A],
      }),
    })
    await run(['--json', 'memory', 'list', 'support'])
    expect(JSON.parse(stdout())).toEqual([MEM_A])
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/profiles/support/memories': jsonResponse({ profile: 'support', total: 1, memories: [MEM_A] }),
    })
    await run(['memory', 'list', 'support'])
    expect(stdout()).toBe('mem_1\tpreference\texplicit\t0.90\t2026-07-01 09:00\tprefers dark mode\n')
  })

  it('passes limit and offset as query params', async () => {
    const calls = stubFetch({
      'GET /api/profiles/support/memories?limit=5&offset=10': jsonResponse({
        profile: 'support',
        total: 0,
        memories: [],
      }),
    })
    await run(['--json', 'memory', 'list', 'support', '--limit', '5', '--offset', '10'])
    expect(calls[0].path).toBe('/api/profiles/support/memories?limit=5&offset=10')
  })

  it('hints an empty state', async () => {
    stubFetch({
      'GET /api/profiles/support/memories': jsonResponse({ profile: 'support', total: 0, memories: [] }),
    })
    await run(['memory', 'list', 'support'])
    expect(stdout()).toBe('')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('No memories')
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({
      'GET /api/profiles/support/memories': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['memory', 'list', 'support'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('memory search', () => {
  const RESULTS = {
    profile: 'support',
    query: 'dark',
    count: 1,
    results: [{ memory: MEM_A, relevance: { score: 0.42, recency: 0.5, usage: 0.3, topic: 0.6 } }],
  }

  it('emits the raw results array with --json', async () => {
    stubFetch({ 'GET /api/profiles/support/memories/search?q=dark': jsonResponse(RESULTS) })
    await run(['--json', 'memory', 'search', 'support', 'dark'])
    expect(JSON.parse(stdout())).toEqual(RESULTS.results)
  })

  it('prints id, score, category, summary in plain mode', async () => {
    stubFetch({ 'GET /api/profiles/support/memories/search?q=dark': jsonResponse(RESULTS) })
    await run(['memory', 'search', 'support', 'dark'])
    expect(stdout()).toBe('mem_1\t0.420\tpreference\tprefers dark mode\n')
  })

  it('passes limit and minScore through', async () => {
    const calls = stubFetch({
      'GET /api/profiles/support/memories/search?q=dark&limit=3&minScore=0.2': jsonResponse({
        profile: 'support',
        query: 'dark',
        count: 0,
        results: [],
      }),
    })
    await run(['--json', 'memory', 'search', 'support', 'dark', '--limit', '3', '--min-score', '0.2'])
    expect(calls[0].path).toBe('/api/profiles/support/memories/search?q=dark&limit=3&minScore=0.2')
  })
})

describe('memory show', () => {
  it('emits the raw memory with --json', async () => {
    stubFetch({ 'GET /api/profiles/support/memories/mem_1': jsonResponse(MEM_A) })
    await run(['--json', 'memory', 'show', 'support', 'mem_1'])
    expect(JSON.parse(stdout())).toEqual(MEM_A)
  })

  it('prints field rows in plain mode', async () => {
    stubFetch({ 'GET /api/profiles/support/memories/mem_1': jsonResponse(MEM_A) })
    await run(['memory', 'show', 'support', 'mem_1'])
    expect(stdout()).toContain('category\tpreference')
    expect(stdout()).toContain('confidence\t0.90')
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({ 'GET /api/profiles/support/memories/nope': jsonResponse({ error: 'memory not found' }, { status: 404 }) })
    await expect(run(['memory', 'show', 'support', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('memory delete', () => {
  it('deletes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/profiles/support/memories/mem_1': jsonResponse({ id: 'mem_1', deleted: true }),
    })
    await run(['--json', 'memory', 'delete', 'support', 'mem_1', '--yes'])
    expect(calls[0].method).toBe('DELETE')
    expect(JSON.parse(stdout())).toEqual({ id: 'mem_1', deleted: true })
  })

  it('refuses without --yes in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['memory', 'delete', 'support', 'mem_1'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })
})

describe('memory bank', () => {
  const SNAP = {
    total: 2,
    profilesWithMemory: 2,
    memories: { support: [MEM_A], triage: [MEM_B] },
  }

  it('emits the raw snapshot with --json', async () => {
    stubFetch({ 'GET /api/memory-bank': jsonResponse(SNAP) })
    await run(['--json', 'memory', 'bank'])
    expect(JSON.parse(stdout())).toEqual(SNAP)
  })

  it('flattens grouped memories into plain rows sorted by profile', async () => {
    stubFetch({ 'GET /api/memory-bank': jsonResponse(SNAP) })
    await run(['memory', 'bank'])
    expect(stdout()).toBe(
      'support\tmem_1\tpreference\tprefers dark mode\t2026-07-01 09:00\n' +
        'triage\tmem_2\tbehavior\tescalate billing issues\t2026-07-03 08:00\n',
    )
  })

  it('hints an empty bank', async () => {
    stubFetch({ 'GET /api/memory-bank': jsonResponse({ total: 0, profilesWithMemory: 0, memories: {} }) })
    await run(['memory', 'bank'])
    expect(stdout()).toBe('')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('empty')
  })
})

describe('memory bank stats', () => {
  const STATS = { totalMemories: 3, profilesWithMemory: 2, perProfile: { support: 2, triage: 1 } }

  it('emits the raw stats with --json', async () => {
    stubFetch({ 'GET /api/memory-bank/stats': jsonResponse(STATS) })
    await run(['--json', 'memory', 'bank', 'stats'])
    expect(JSON.parse(stdout())).toEqual(STATS)
  })

  it('prints per-profile counts (desc) in plain mode', async () => {
    stubFetch({ 'GET /api/memory-bank/stats': jsonResponse(STATS) })
    await run(['memory', 'bank', 'stats'])
    expect(stdout()).toBe('support\t2\ntriage\t1\n')
  })

  it('maps a 503 to a failure exit code', async () => {
    stubFetch({
      'GET /api/memory-bank/stats': jsonResponse({ error: 'memory bank not configured' }, { status: 503 }),
    })
    await expect(run(['memory', 'bank', 'stats'])).rejects.toMatchObject({ exitCode: ExitCode.Failure })
  })
})
