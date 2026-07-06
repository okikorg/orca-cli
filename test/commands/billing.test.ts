import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerBilling } from '../../src/commands/billing.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerBilling(program)
  await program.parseAsync(args, { from: 'user' })
}

// capResponse builds a well-formed GET/PUT /api/spend-cap payload.
function capResponse(opts?: { limitCents?: number; spentCents?: number; userSet?: boolean }) {
  const limit = opts?.limitCents ?? 10000
  const spent = opts?.spentCents ?? 0
  return {
    enabled: true,
    month: {
      limit_usd_cents: limit,
      limit_usd: limit / 100,
      spent_usd_cents: spent,
      spent_usd: spent / 100,
      remaining_usd_cents: Math.max(0, limit - spent),
      user_set: opts?.userSet ?? true,
      resets_at: '2026-08-01T00:00:00Z',
    },
    day: {
      limit_usd_cents: 1000,
      limit_usd: 10,
      spent_usd_cents: 0,
      spent_usd: 0,
      remaining_usd_cents: 1000,
      user_set: false,
      resets_at: '2026-07-06T00:00:00Z',
    },
    billing_email: 'ops@acme.com',
  }
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

describe('billing wallet', () => {
  it('emits the raw wallet with --json', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse({
        configured: true,
        balanceMicroUSD: 12_500_000,
        balanceUSD: 12.5,
        packs: [{ cents: 1000, usd: 10 }],
      }),
    })
    await run(['--json', 'billing', 'wallet'])
    expect(JSON.parse(stdout())).toMatchObject({ configured: true, balanceUSD: 12.5 })
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse({
        configured: true,
        balanceMicroUSD: 12_500_000,
        balanceUSD: 12.5,
        packs: [{ cents: 1000, usd: 10 }, { cents: 5000, usd: 50 }],
      }),
    })
    await run(['billing', 'wallet'])
    expect(stdout()).toBe('configured\ttrue\nbalanceUSD\t12.50\nbalanceMicroUSD\t12500000\npacks\t1000,5000\n')
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse({ error: 'bad key' }, { status: 401 }) })
    await expect(run(['billing', 'wallet'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('billing cap (show)', () => {
  it('emits the raw spend cap with --json', async () => {
    stubFetch({ 'GET /api/spend-cap': jsonResponse(capResponse({ limitCents: 5000, spentCents: 1200 })) })
    await run(['--json', 'billing', 'cap'])
    expect(JSON.parse(stdout())).toMatchObject({ month: { limit_usd_cents: 5000, spent_usd_cents: 1200 } })
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({ 'GET /api/spend-cap': jsonResponse(capResponse({ limitCents: 5000, spentCents: 1200 })) })
    await run(['billing', 'cap'])
    const out = stdout()
    expect(out).toContain('limit_usd_cents\t5000\n')
    expect(out).toContain('spent_usd_cents\t1200\n')
    expect(out).toContain('billing_email\tops@acme.com\n')
  })
})

describe('billing cap set (cents parsing)', () => {
  it.each([
    ['10', 1000],
    ['10.5', 1050],
    ['10.50', 1050],
    ['$10', 1000],
    ['1,000', 100000],
  ])('parses %s dollars to %d cents', async (amount, expectedCents) => {
    const calls = stubFetch({
      'GET /api/spend-cap': jsonResponse(capResponse()),
      'PUT /api/spend-cap': jsonResponse(capResponse()),
    })
    await run(['billing', 'cap', 'set', amount, '--yes'])
    const put = calls.find((c) => c.method === 'PUT')
    expect(put).toBeDefined()
    expect(JSON.parse(put!.body ?? '{}')).toEqual({ monthly_cap_usd_cents: expectedCents })
  })

  it('rejects "abc" as a usage error with no network call', async () => {
    const calls = stubFetch({})
    await expect(run(['billing', 'cap', 'set', 'abc', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects a negative amount as a usage error', async () => {
    const calls = stubFetch({})
    // `--` stops commander option parsing so the negative reaches the parser.
    await expect(run(['billing', 'cap', 'set', '--yes', '--', '-5'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects three decimal places', async () => {
    const calls = stubFetch({})
    await expect(run(['billing', 'cap', 'set', '10.501', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('billing cap set (behavior)', () => {
  it('clears the override when given "default"', async () => {
    const calls = stubFetch({
      'GET /api/spend-cap': jsonResponse(capResponse()),
      'PUT /api/spend-cap': jsonResponse(capResponse({ userSet: false })),
    })
    await run(['billing', 'cap', 'set', 'default', '--yes'])
    const put = calls.find((c) => c.method === 'PUT')
    expect(JSON.parse(put!.body ?? '{}')).toEqual({ monthly_cap_usd_cents: null })
  })

  it('warns when the new cap is below this month spend', async () => {
    stubFetch({
      'GET /api/spend-cap': jsonResponse(capResponse({ limitCents: 10000, spentCents: 5000 })),
      'PUT /api/spend-cap': jsonResponse(capResponse()),
    })
    await run(['billing', 'cap', 'set', '10', '--yes'])
    const warned = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.map(String).join(' '))
      .join('\n')
    expect(warned).toContain('below')
  })

  it('refuses without --yes when not interactive', async () => {
    const calls = stubFetch({ 'GET /api/spend-cap': jsonResponse(capResponse()) })
    await expect(run(['billing', 'cap', 'set', '20'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined()
  })

  it('maps a 403 on write to the auth exit code', async () => {
    stubFetch({
      'GET /api/spend-cap': jsonResponse(capResponse()),
      'PUT /api/spend-cap': jsonResponse({ error: 'admin only' }, { status: 403 }),
    })
    await expect(run(['billing', 'cap', 'set', '20', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Auth,
    })
  })
})
