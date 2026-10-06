import { Command } from 'commander'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDoctor } from '../../src/commands/doctor.js'
import { saveConfig } from '../../src/lib/config.js'
import { DoctorReport } from '../../src/ui/DoctorReport.js'
import { glyphs } from '../../src/ui/theme.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'orca_sk_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmn'

let cleanup: () => Promise<void>
let prevExit: typeof process.exitCode

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerDoctor(program)
  await program.parseAsync(args, { from: 'user' })
}

// Healthy-server route table: reachable, valid key, funded wallet.
// Individual tests override entries to force a failure.
function healthyRoutes(overrides?: Record<string, ReturnType<typeof jsonResponse> | Response>) {
  return {
    'GET /health': jsonResponse({ status: 'ok', release: 'test' }),
    'GET /api/whoami': jsonResponse({ object: 'whoami', tenant: 'org_1', actor: 'user_1', role: 'admin', agent: null }),
    'GET /api/billing/wallet': jsonResponse({ balance_micro_usd: 9_000_000, min_balance_micro_usd: 500_000, paid_work_paused: false, tier: 'free' }),
    ...overrides,
  }
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  prevExit = process.exitCode
  process.exitCode = 0
  delete process.env.ORCA_API_KEY
  delete process.env.ORCA_API_URL
  delete process.env.ORCA_CONTEXT
  await saveConfig({
    currentContext: 'default',
    contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY, keyId: 'key_9' } },
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  await cleanup()
  process.exitCode = prevExit
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .join('')
}

describe('orca doctor (plain output)', () => {
  it('prints name/status/message tab-separated rows and exits 0 when healthy', async () => {
    stubFetch(healthyRoutes())
    await run(['doctor'])
    const out = stdout()
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('node version\tpass\t' + lines[0].split('\t')[2])
    expect(out).toContain('server\tpass\t')
    expect(out).toContain('api key\tpass\t')
    expect(out).toContain('billing\tpass\t')
    // Every row is exactly three tab-separated columns.
    for (const l of lines) expect(l.split('\t')).toHaveLength(3)
    expect(process.exitCode).toBe(0)
  })

  it('exits 1 and surfaces the missing-key fix when no key is configured', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080' } },
    })
    stubFetch(healthyRoutes())
    await run(['doctor'])
    expect(process.exitCode).toBe(1)
    expect(stdout()).toContain('api key\tfail\t')
  })

  it('exits 1 when the server is unreachable', async () => {
    // No /health route -> stubFetch throws TypeError (network error).
    stubFetch({
      'GET /api/whoami': jsonResponse({ role: 'admin' }),
      'GET /api/billing/wallet': jsonResponse({ balance_micro_usd: 9_000_000, min_balance_micro_usd: 500_000, paid_work_paused: false }),
    })
    await run(['doctor'])
    expect(process.exitCode).toBe(1)
    expect(stdout()).toContain('server\tfail\t')
  })
})

describe('orca doctor (json output)', () => {
  it('emits an array of {name,status,message,fix?} objects', async () => {
    stubFetch(healthyRoutes())
    await run(['--json', 'doctor'])
    const arr = JSON.parse(stdout()) as { name: string; status: string; message: string; fix?: string }[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr).toHaveLength(10)
    expect(arr.find((r) => r.name === 'api key role')!.message).toBe('valid; admin of org_1')
    // A passing row carries no fix key.
    const node = arr.find((r) => r.name === 'node version')!
    expect('fix' in node).toBe(false)
  })

  it('warns, with a fix, when the wallet is empty', async () => {
    stubFetch(healthyRoutes({ 'GET /api/billing/wallet': jsonResponse({ balance_micro_usd: 0, min_balance_micro_usd: 500_000, paid_work_paused: true, tier: 'free' }) }))
    await run(['--json', 'doctor'])
    const arr = JSON.parse(stdout()) as { name: string; status: string; fix?: string }[]
    const billing = arr.find((r) => r.name === 'billing')!
    expect(billing.status).toBe('warn')
    expect(billing.fix).toContain('orca billing buy')
    expect(process.exitCode).toBe(0)
  })
})

describe('orca doctor --strict', () => {
  it('promotes the empty-wallet warn to a failure and exits 1', async () => {
    stubFetch(healthyRoutes({ 'GET /api/billing/wallet': jsonResponse({ balance_micro_usd: 0, min_balance_micro_usd: 500_000, paid_work_paused: true, tier: 'free' }) }))
    await run(['--json', 'doctor', '--strict'])
    const arr = JSON.parse(stdout()) as { name: string; status: string }[]
    expect(arr.find((r) => r.name === 'billing')!.status).toBe('fail')
    expect(process.exitCode).toBe(1)
  })
})

describe('DoctorReport (TTY rendering)', () => {
  it('renders a borderless report with a header line, glyph status rows, fix lines, and a footer summary', () => {
    const { lastFrame } = render(
      <DoctorReport
        host="test:8080"
        results={[
          { name: 'server', status: 'pass', message: 'reachable in 11ms (HTTP 200)' },
          { name: 'api key', status: 'fail', message: 'no API key configured', fix: 'run orca auth login' },
          { name: 'dashboard url', status: 'warn', message: 'no dashboard URL' },
          { name: 'billing', status: 'skip', message: 'skipped (no API key)' },
        ]}
      />,
    )
    const frame = lastFrame() ?? ''
    // Header line: title, host, and check count (borderless, no "DOCTOR" box).
    expect(frame).toContain('Doctor')
    expect(frame).toContain('test:8080')
    expect(frame).toContain('4 checks')
    // Status words, one per row.
    expect(frame).toContain('ok')
    expect(frame).toContain('fail')
    expect(frame).toContain('warn')
    expect(frame).toContain('skip')
    expect(frame).toContain('server')
    // Every status column keeps a visible gutter before the check name. In
    // particular, four-letter statuses must not collapse into `failapi key`
    // or `warndashboard url`.
    expect(frame).toContain(`${glyphs.statusFilled} ok    server`)
    expect(frame).toContain(`${glyphs.statusFilled} fail  api key`)
    expect(frame).toContain(`${glyphs.statusFilled} warn  dashboard url`)
    expect(frame).toContain(`${glyphs.statusOpen} skip  billing`)
    // Status glyphs come from the active tier (filled dot for pass/warn/fail,
    // open dot for skip); assert whichever tier this run resolved to.
    expect(frame).toContain(glyphs.statusFilled)
    expect(frame).toContain(glyphs.statusOpen)
    // The fix line appears under the failing row.
    expect(frame).toContain('fix: run orca auth login')
    // Footer summary counts, colored per severity.
    expect(frame).toContain('1 ok')
    expect(frame).toContain('1 warn')
    expect(frame).toContain('1 fail')
  })
})
