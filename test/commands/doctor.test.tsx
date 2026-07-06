import { Command } from 'commander'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDoctor } from '../../src/commands/doctor.js'
import { saveConfig } from '../../src/lib/config.js'
import { DoctorReport } from '../../src/ui/DoctorReport.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>
let prevExit: typeof process.exitCode

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerDoctor(program)
  await program.parseAsync(args, { from: 'user' })
}

// Healthy-conductor route table: reachable, valid member+ key, funded wallet,
// cap disabled. Individual tests override entries to force a failure.
function healthyRoutes(overrides?: Record<string, ReturnType<typeof jsonResponse> | Response>) {
  return {
    'GET /healthz': () => new Response('ok', { status: 200 }),
    'GET /api/api-keys': jsonResponse({ keys: [{ id: 'key_9', role: 'admin', name: 'cli' }] }),
    'GET /api/billing/wallet': jsonResponse({ configured: true, balanceUSD: 9 }),
    'GET /api/spend-cap': jsonResponse({ enabled: false }),
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
  delete process.env.ORCA_GATEWAY_URL
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
    expect(out).toContain('conductor\tpass\t')
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

  it('exits 1 when the conductor is unreachable', async () => {
    // No /healthz route -> stubFetch throws TypeError (network error).
    stubFetch({
      'GET /api/api-keys': jsonResponse({ keys: [] }),
      'GET /api/billing/wallet': jsonResponse({ configured: true, balanceUSD: 9 }),
      'GET /api/spend-cap': jsonResponse({ enabled: false }),
    })
    await run(['doctor'])
    expect(process.exitCode).toBe(1)
    expect(stdout()).toContain('conductor\tfail\t')
  })
})

describe('orca doctor (json output)', () => {
  it('emits an array of {name,status,message,fix?} objects', async () => {
    stubFetch(healthyRoutes())
    await run(['--json', 'doctor'])
    const arr = JSON.parse(stdout()) as { name: string; status: string; fix?: string }[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr).toHaveLength(11)
    // The baked-in production gateway default applies, and the stubbed
    // /healthz answer marks it reachable.
    const gateway = arr.find((r) => r.name === 'chat gateway')!
    expect(gateway.status).toBe('pass')
    // A passing row carries no fix key.
    const node = arr.find((r) => r.name === 'node version')!
    expect('fix' in node).toBe(false)
  })

  it('maps a billing 402-risk (unconfigured wallet) to a fail with a fix', async () => {
    stubFetch(
      healthyRoutes({ 'GET /api/billing/wallet': jsonResponse({ configured: false, balanceUSD: 0 }) }),
    )
    await run(['--json', 'doctor'])
    const arr = JSON.parse(stdout()) as { name: string; status: string; fix?: string }[]
    const billing = arr.find((r) => r.name === 'billing')!
    expect(billing.status).toBe('fail')
    expect(billing.fix).toContain('add credits')
    expect(process.exitCode).toBe(1)
  })
})

describe('orca doctor --strict', () => {
  it('promotes the gateway warn to a failure and exits 1', async () => {
    // A configured-but-unreachable gateway warns; --strict promotes it. The
    // /dead path prefix keeps its healthz distinct from the conductor's in
    // the path-keyed fetch stub (no route -> network error).
    await saveConfig({
      currentContext: 'default',
      contexts: {
        default: {
          apiUrl: 'http://test:8080',
          apiKey: KEY,
          keyId: 'key_9',
          gatewayUrl: 'http://gw:1/dead',
        },
      },
    })
    stubFetch(healthyRoutes())
    await run(['--json', 'doctor', '--strict'])
    const arr = JSON.parse(stdout()) as { name: string; status: string }[]
    expect(arr.find((r) => r.name === 'chat gateway')!.status).toBe('fail')
    expect(process.exitCode).toBe(1)
  })
})

describe('DoctorReport (TTY rendering)', () => {
  it('renders a DOCTOR panel with themed status cells and fix lines', () => {
    const { lastFrame } = render(
      <DoctorReport
        subtitle="1 failed, 1 warned, 1 ok"
        results={[
          { name: 'conductor', status: 'pass', message: 'reachable in 11ms (HTTP 200)' },
          { name: 'api key', status: 'fail', message: 'no API key configured', fix: 'run orca auth login' },
          { name: 'chat gateway', status: 'warn', message: 'no chat gateway URL' },
          { name: 'billing', status: 'skip', message: 'skipped (no API key)' },
        ]}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('DOCTOR')
    expect(frame).toContain('1 failed, 1 warned, 1 ok')
    expect(frame).toContain('ok')
    expect(frame).toContain('fail')
    expect(frame).toContain('warn')
    expect(frame).toContain('skip')
    expect(frame).toContain('conductor')
    // The fix line appears under the failing row.
    expect(frame).toContain('fix: run orca auth login')
  })
})
