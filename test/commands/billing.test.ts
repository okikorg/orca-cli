import { afterEach, describe, expect, it } from 'vitest'

import { parseOffer, registerBilling } from '../../src/commands/billing.js'
import { setBrowserOpener } from '../../src/lib/browser.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const WALLET = {
  object: 'billing.wallet',
  balance_micro_usd: 18_500_000,
  credited_micro_usd: 20_000_000,
  charged_micro_usd: 1_500_000,
  tier: 'pro',
  period_start: 1_783_245_600,
  period_end: 1_785_837_600,
  included_compute_seconds: 36_000,
  used_compute_seconds: 120,
  packs: [{ cents: 2000, fee_cents: 180, credited_micro_usd: 18_200_000 }],
  processing_fee: { bps: 650, flat_cents: 50 },
}

const { run, stdout } = commandHarness(registerBilling)

afterEach(() => {
  setBrowserOpener(null)
})

describe('billing wallet', () => {
  it('formats the server\'s micro-USD figures', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse(WALLET) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('balance\t$18.50')
    expect(stdout()).toContain('tier\tpro')
    expect(stdout()).toContain('packs\tpack:2000')
  })

  it('passes the wallet through with --json', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse(WALLET) })
    await run(['--json', 'billing', 'wallet'])
    expect(JSON.parse(stdout())).toEqual(WALLET)
  })
})

describe('billing buy', () => {
  it('opens a checkout for a plan and prints the link when piped', async () => {
    const opened: string[] = []
    setBrowserOpener((url) => opened.push(url))
    const calls = stubFetch({
      'POST /api/billing/checkout': jsonResponse({ url: 'https://sandbox.polar.sh/checkout/abc' }),
    })
    await run(['billing', 'buy', 'pro'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ offer: 'plan:pro' })
    expect(stdout()).toBe('https://sandbox.polar.sh/checkout/abc\n')
    // Not a terminal: nothing is opened.
    expect(opened).toEqual([])
  })

  it('sends a pack by its cents', async () => {
    const calls = stubFetch({ 'POST /api/billing/checkout': jsonResponse({ url: 'https://x' }) })
    await run(['billing', 'buy', 'pack:2000'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ offer: 'pack:2000' })
  })

  it('rejects an unknown offer before any request', async () => {
    const calls = stubFetch({})
    await expect(run(['billing', 'buy', 'gold'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('maps the admin-only refusal to the auth exit code', async () => {
    stubFetch({
      'POST /api/billing/checkout': jsonResponse(
        { error: { message: 'This action requires the admin role' } },
        { status: 403 },
      ),
    })
    await expect(run(['billing', 'buy', 'max'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('billing manage', () => {
  it('opens the portal', async () => {
    const calls = stubFetch({ 'POST /api/billing/portal': jsonResponse({ url: 'https://sandbox.polar.sh/portal' }) })
    await run(['--json', 'billing', 'manage'])
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(stdout())).toEqual({ url: 'https://sandbox.polar.sh/portal' })
  })
})

describe('parseOffer', () => {
  it('accepts plans and packs', () => {
    expect(parseOffer('Pro')).toBe('plan:pro')
    expect(parseOffer('plan:max')).toBe('plan:max')
    expect(parseOffer('pack:500')).toBe('pack:500')
    expect(() => parseOffer('pack:5.00')).toThrow()
  })
})
