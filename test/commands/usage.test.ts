import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerUsage } from '../../src/commands/usage.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// Mirrors runtime/httpapi/stats.go statsTimeseriesDTO (GET /api/stats/timeseries).
const TIMESERIES = {
  window: '7d',
  bucket: '1h0m0s',
  since: '2026-07-01T00:00:00Z',
  until: '2026-07-02T00:00:00Z',
  buckets: [
    {
      start: '2026-07-01T00:00:00Z',
      end: '2026-07-01T12:00:00Z',
      runs: 2,
      failedRuns: 0,
      runningRuns: 0,
      tokens: { inputTokens: 100, outputTokens: 50 },
      costCents: 0,
    },
    {
      start: '2026-07-01T12:00:00Z',
      end: '2026-07-02T00:00:00Z',
      runs: 3,
      failedRuns: 1,
      runningRuns: 0,
      tokens: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 50 },
      costCents: 12,
    },
  ],
}

// Mirrors runtime/httpapi/usage.go usageResponseDTO (GET /api/usage, PR #169).
const METERS = {
  window: '7d',
  totals: { toolCalls: 7, sandboxSeconds: 12.5 },
  byProfile: [{ profile: 'a', toolCalls: 7, sandboxSeconds: 12.5 }],
}

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerUsage(program)
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

describe('usage --json', () => {
  it('emits the combined stats + meter payload', async () => {
    stubFetch({
      'GET /api/stats/timeseries?window=7d': jsonResponse(TIMESERIES),
      'GET /api/usage?window=7d': jsonResponse(METERS),
    })
    await run(['--json', 'usage'])
    expect(JSON.parse(stdout())).toEqual({
      window: '7d',
      meter: 'tokens',
      timeseries: TIMESERIES,
      meters: METERS,
    })
  })

  it('reports meters:null when GET /api/usage is unavailable', async () => {
    stubFetch({
      'GET /api/stats/timeseries?window=7d': jsonResponse(TIMESERIES),
      'GET /api/usage?window=7d': jsonResponse({ error: 'not found' }, { status: 404 }),
    })
    await run(['--json', 'usage'])
    expect(JSON.parse(stdout()).meters).toBeNull()
  })
})

describe('usage plain mode', () => {
  it('prints one tab-separated row per bucket for the token meter by default', async () => {
    stubFetch({
      'GET /api/stats/timeseries?window=7d': jsonResponse(TIMESERIES),
      'GET /api/usage?window=7d': jsonResponse(METERS),
    })
    await run(['usage'])
    expect(stdout()).toBe(
      '2026-07-01 00:00\ttokens\t150\t\n2026-07-01 12:00\ttokens\t350\t0.12\n',
    )
  })

  it('switches the plotted quantity with --meter cost', async () => {
    stubFetch({
      'GET /api/stats/timeseries?window=7d': jsonResponse(TIMESERIES),
      'GET /api/usage?window=7d': jsonResponse(METERS),
    })
    await run(['usage', '--meter', 'cost'])
    expect(stdout()).toBe('2026-07-01 00:00\tcost\t0\t\n2026-07-01 12:00\tcost\t0.12\t0.12\n')
  })

  it('switches the plotted quantity with --meter runs', async () => {
    stubFetch({
      'GET /api/stats/timeseries?window=7d': jsonResponse(TIMESERIES),
      'GET /api/usage?window=7d': jsonResponse(METERS),
    })
    await run(['usage', '--meter', 'runs'])
    expect(stdout()).toBe('2026-07-01 00:00\truns\t2\t\n2026-07-01 12:00\truns\t3\t0.12\n')
  })
})

describe('usage windowing', () => {
  it('maps --days N onto the window=Nd query', async () => {
    const calls = stubFetch({
      'GET /api/stats/timeseries?window=3d': jsonResponse(TIMESERIES),
      'GET /api/usage?window=3d': jsonResponse(METERS),
    })
    await run(['usage', '--days', '3'])
    expect(calls[0].path).toBe('/api/stats/timeseries?window=3d')
  })

  it('passes --window through verbatim', async () => {
    const calls = stubFetch({
      'GET /api/stats/timeseries?window=24h': jsonResponse(TIMESERIES),
      'GET /api/usage?window=24h': jsonResponse(METERS),
    })
    await run(['usage', '--window', '24h'])
    expect(calls[0].path).toBe('/api/stats/timeseries?window=24h')
  })
})

describe('usage validation', () => {
  it('rejects an unplottable meter with the usage exit code', async () => {
    stubFetch({})
    await expect(run(['usage', '--meter', 'toolcalls'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('maps a 401 on the stats endpoint to the auth exit code', async () => {
    stubFetch({
      'GET /api/stats/timeseries?window=7d': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['usage'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})
