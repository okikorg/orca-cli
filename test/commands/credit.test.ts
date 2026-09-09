import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerCredit } from '../../src/commands/credit.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerCredit(program)
  await program.parseAsync(args, { from: 'user' })
}

// walletResponse builds a well-formed GET /api/billing/wallet payload.
// Mirrors the conductor's billing.go handler.
function walletResponse(opts?: { configured?: boolean; balanceUSD?: number }) {
  const balanceUSD = opts?.balanceUSD ?? 12.5
  return {
    configured: opts?.configured ?? true,
    balanceMicroUSD: Math.round(balanceUSD * 1_000_000),
    balanceUSD,
    packs: [
      { cents: 1000, usd: 10 },
      { cents: 5000, usd: 50 },
    ],
  }
}

// capResponse builds a well-formed GET /api/spend-cap payload.
// Mirrors the conductor's spendcap_settings.go handler.
function capResponse(opts?: { limitCents?: number; spentCents?: number }) {
  const limit = opts?.limitCents ?? 10000
  const spent = opts?.spentCents ?? 1200
  return {
    enabled: true,
    month: {
      limit_usd_cents: limit,
      limit_usd: limit / 100,
      spent_usd_cents: spent,
      spent_usd: spent / 100,
      remaining_usd_cents: Math.max(0, limit - spent),
      user_set: true,
      resets_at: '2026-10-01T00:00:00Z',
    },
    day: {
      limit_usd_cents: 1000,
      limit_usd: 10,
      spent_usd_cents: 0,
      spent_usd: 0,
      remaining_usd_cents: 1000,
      user_set: false,
      resets_at: '2026-09-10T00:00:00Z',
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

function stderr(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((c) => c.map(String).join(' '))
    .join('\n')
}

describe('credit', () => {
  it('emits both payloads under wallet and cap keys with --json', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse(walletResponse({ balanceUSD: 4.08 })),
      'GET /api/spend-cap': jsonResponse(capResponse({ limitCents: 200000, spentCents: 92 })),
    })
    await run(['--json', 'credit'])
    expect(JSON.parse(stdout())).toMatchObject({
      wallet: { configured: true, balanceUSD: 4.08 },
      cap: { month: { limit_usd_cents: 200000, spent_usd_cents: 92 } },
    })
  })

  it('prints balance, spend and cap headroom as tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse(walletResponse({ balanceUSD: 4.08 })),
      'GET /api/spend-cap': jsonResponse(capResponse({ limitCents: 200000, spentCents: 92 })),
    })
    await run(['credit'])
    expect(stdout()).toBe(
      [
        'balanceUSD\t4.08',
        'balanceMicroUSD\t4080000',
        'spent_usd_cents\t92',
        'cap_remaining_usd_cents\t199908',
        'resets_at\t2026-10-01T00:00:00Z',
        'packs\t1000,5000',
        '',
      ].join('\n'),
    )
  })

  it('omits the balance rows when the tenant has no credit wallet configured', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse(walletResponse({ configured: false, balanceUSD: 0 })),
      'GET /api/spend-cap': jsonResponse(capResponse()),
    })
    await run(['credit'])
    const out = stdout()
    expect(out).not.toContain('balanceUSD')
    expect(out).toContain('configured\tfalse\n')
    expect(out).toContain('cap_remaining_usd_cents\t8800\n')
  })

  it('still reports the cap when the wallet endpoint fails', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse({ error: 'no meter' }, { status: 503 }),
      'GET /api/spend-cap': jsonResponse(capResponse({ limitCents: 200000, spentCents: 92 })),
    })
    await run(['credit'])
    expect(stdout()).toContain('cap_remaining_usd_cents\t199908\n')
    expect(stderr()).toContain('credit balance unavailable')
  })

  it('still reports the balance when the spend cap endpoint fails', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse(walletResponse({ balanceUSD: 4.08 })),
      'GET /api/spend-cap': jsonResponse({ error: 'boom' }, { status: 503 }),
    })
    await run(['credit'])
    expect(stdout()).toContain('balanceUSD\t4.08\n')
    expect(stderr()).toContain('spend cap unavailable')
  })

  it('fails when neither endpoint answers', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse({ error: 'boom' }, { status: 503 }),
      'GET /api/spend-cap': jsonResponse({ error: 'boom' }, { status: 503 }),
    })
    await expect(run(['credit'])).rejects.toMatchObject({ exitCode: ExitCode.Failure })
  })

  it('maps a 401 to the auth exit code rather than degrading', async () => {
    stubFetch({
      'GET /api/billing/wallet': jsonResponse({ error: 'bad key' }, { status: 401 }),
      'GET /api/spend-cap': jsonResponse({ error: 'bad key' }, { status: 401 }),
    })
    await expect(run(['credit'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})
