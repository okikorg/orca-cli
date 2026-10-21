import { afterEach, describe, expect, it } from 'vitest'

import { parseOffer, registerBilling } from '../../src/commands/billing.js'
import { setBrowserOpener } from '../../src/lib/browser.js'
import { ExitCode } from '../../src/lib/errors.js'
import { API, commandHarness, KEY } from '../helpers/cli.js'
import { saveConfig } from '../../src/lib/config.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const WALLET = {
  object: 'billing.wallet',
  balance_micro_usd: 18_500_000,
  credited_micro_usd: 20_000_000,
  charged_micro_usd: 1_500_000,
  min_balance_micro_usd: 500_000,
  paid_work_paused: false,
  tier: 'pro',
  period_start: 1_783_245_600,
  period_end: 1_785_837_600,
  included_compute_seconds: 36_000,
  used_compute_seconds: 120,
  packs: [{ cents: 2000, fee_cents: 180, credited_micro_usd: 18_200_000 }],
  processing_fee: { bps: 650, flat_cents: 50 },
  openrouter_fee_bps: 550,
}

// A Free organization's wallet (free-plan D3.16): granted and paid credit,
// the free model today, the network off and where to ask for credit.
const NETWORK = 'Network is off on Free sandboxes until your organization has credit. Add credit, or write to us on Discord (https://discord.gg/btTYzdzvqq).'
const MORE_CREDIT = 'Need more to try Orca? Write to us on Discord (https://discord.gg/btTYzdzvqq).'
const FREE_WALLET = {
  ...WALLET,
  tier: 'free',
  included_compute_seconds: 3_600,
  used_compute_seconds: 1_440,
  granted_credit_micro_usd: 12_400_000,
  paid_credit_micro_usd: 6_100_000,
  granted_credit: [
    { kind: 'grant', grant_reason: 'on_request', granted_micro_usd: 20_000_000, left_micro_usd: 12_400_000, granted_at: 1_793_750_400, expires_at: 1_796_428_800 },
  ],
  expired_micro_usd: 0,
  free_model_today: { calls_today: 40, calls_per_day: 100, available: true },
  included_hours_withheld: false,
  network: { off: true, message: NETWORK },
  credit_request: { message: MORE_CREDIT, url: 'https://discord.gg/btTYzdzvqq' },
}

const { run, stdout, stderr } = commandHarness(registerBilling)

afterEach(() => {
  setBrowserOpener(null)
})

describe('billing wallet', () => {
  it('formats the server\'s micro-USD figures', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse(WALLET) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('balance\t$18.50')
    expect(stdout()).toContain('credited\t$20.00')
    expect(stdout()).toContain('charged\t$1.50')
    expect(stdout()).toContain('min_balance\t$0.50')
    expect(stdout()).toContain('paid_work_paused\tfalse')
    expect(stdout()).toContain('tier\tpro')
    expect(stdout()).toContain('packs\tpack:2000')
    // Field names as the server spells them, for grep and cut.
    expect(stdout()).toContain('period_start\t')
    expect(stdout()).toContain('included_compute_seconds\t36000')
    // OpenRouter's fee on Orca credit, as the server sends it.
    expect(stdout()).toContain('openrouter_fee_bps\t550')
  })

  it('shows paused as the server says, even with a positive balance', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse({ ...WALLET, balance_micro_usd: 250_000, paid_work_paused: true }) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('balance\t$0.25')
    expect(stdout()).toContain('paid_work_paused\ttrue')
  })

  it('passes the wallet through with --json', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse(WALLET) })
    await run(['--json', 'billing', 'wallet'])
    expect(JSON.parse(stdout())).toEqual(WALLET)
  })

  it('prints a balance below zero as it is, and one line naming the minimum', async () => {
    // A late charge took the balance below zero: the server pauses paid work.
    stubFetch({ 'GET /api/billing/wallet': jsonResponse({ ...WALLET, balance_micro_usd: -600_000, paid_work_paused: true }) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('balance\t-$0.60')
    expect(stdout()).toContain('min_balance\t$0.50')
    // The rows stay key and value; the note is on stderr, once.
    expect(stdout()).not.toContain('below zero')
    expect(stderr()).toBe('Your balance is below zero. Paid work resumes when credit brings it to $0.50.\n')
  })

  it('adds no line at a balance of zero or above, even when paused', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse({ ...WALLET, balance_micro_usd: 0, paid_work_paused: true }) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('balance\t$0.00')
    expect(stderr()).toBe('')
  })

  it('passes a negative balance through untouched with --json, with no line added', async () => {
    const wallet = { ...WALLET, balance_micro_usd: -600_000, paid_work_paused: true }
    stubFetch({ 'GET /api/billing/wallet': jsonResponse(wallet) })
    await run(['--json', 'billing', 'wallet'])
    expect(JSON.parse(stdout())).toEqual(wallet)
    expect(stderr()).toBe('')
  })
})

describe('billing wallet on Free (free-plan D3.16)', () => {
  it('adds granted and paid credit, each grant with its last day, and the free model today', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse(FREE_WALLET) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('granted_credit\t$12.40\n')
    expect(stdout()).toContain('paid_credit\t$6.10\n')
    // What is left, what was granted, and the last day it can be spent.
    expect(stdout()).toContain('grant\t$12.40\t$20.00\t2026-12-04\n')
    expect(stdout()).toContain('expired\t$0.00\n')
    expect(stdout()).toContain('free_model_calls_today\t40\nfree_model_calls_per_day\t100\n')
    expect(stdout()).toContain('network_off\ttrue\n')
    expect(stdout()).toContain('included_hours_withheld\tfalse\n')
    // The server's messages go to stderr, the rows stay key and value.
    expect(stdout()).not.toContain('Discord')
    expect(stderr()).toBe(`network  off. ${NETWORK}\nmore credit  ${MORE_CREDIT}\n`)
  })

  it('says when Free\'s included hour and free model are withheld (amendment A2)', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse({ ...FREE_WALLET, included_hours_withheld: true, network: { off: false }, credit_request: null }) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('included_hours_withheld\ttrue\n')
    expect(stderr()).toBe(
      "Free's included hour and free model are not available for this organization. Add credit, or bring your own provider key.\n",
    )
  })

  it('passes every new field through with --json', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse(FREE_WALLET) })
    await run(['--json', 'billing', 'wallet'])
    expect(JSON.parse(stdout())).toEqual(FREE_WALLET)
    expect(stderr()).toBe('')
  })

  it('prints the network\'s message and count while running sandboxes started without it (amendment A6 (28))', async () => {
    const ON = 'Your organization has credit, so the network is on. A running sandbox that started without it gets it after its next sleep.'
    stubFetch({ 'GET /api/billing/wallet': jsonResponse({ ...FREE_WALLET, network: { off: false, sandboxes_without_network: 2, message: ON } }) })
    await run(['billing', 'wallet'])
    expect(stdout()).toContain('network_off\tfalse\nsandboxes_without_network\t2\n')
    expect(stderr()).toContain(`network  on. ${ON}\n`)
  })

  it('adds nothing on Pro, where the server sends no Free plan fields', async () => {
    stubFetch({ 'GET /api/billing/wallet': jsonResponse({ ...WALLET, free_model_today: null, network: { off: false }, credit_request: null }) })
    await run(['billing', 'wallet'])
    expect(stdout()).not.toContain('free_model')
    expect(stdout()).toContain('network_off\tfalse\n')
    expect(stdout()).not.toContain('sandboxes_without_network')
    expect(stderr()).toBe('')
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

  it('tells the server which dashboard to send the buyer back to', async () => {
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: API, apiKey: KEY, dashboardUrl: 'http://localhost:5173' } } })
    const calls = stubFetch({ 'POST /api/billing/checkout': jsonResponse({ url: 'https://x' }) })
    await run(['billing', 'buy', 'pro'])
    expect(calls[0].headers.Origin).toBe('http://localhost:5173')
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
