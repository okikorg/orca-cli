import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import type { Wallet } from '../../src/lib/types.js'
import { WalletView } from '../../src/ui/WalletView.js'

const WALLET: Wallet = {
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
  packs: [],
  processing_fee: { bps: 650, flat_cents: 50 },
  openrouter_fee_bps: 550,
}

const NOTE = 'Your balance is below zero. Paid work resumes when credit brings it to $0.50.'

// A Free organization in October 2026 (free-plan D3.16): the free model
// today, the network off, the request line, honoured signup credit and an
// operator grant, soonest expiry first.
const NETWORK = 'Network is off on Free sandboxes until your organization has credit. Add credit, or write to us on Discord (https://discord.gg/btTYzdzvqq).'
const MORE_CREDIT = 'Need more to try Orca? Write to us on Discord (https://discord.gg/btTYzdzvqq).'
const FREE_WALLET: Wallet = {
  ...WALLET,
  balance_micro_usd: 35_600_000,
  tier: 'free',
  period_start: 1_790_812_800,
  period_end: 1_793_491_200,
  included_compute_seconds: 3_600,
  used_compute_seconds: 1_440,
  granted_credit_micro_usd: 17_400_000,
  paid_credit_micro_usd: 18_200_000,
  granted_credit: [
    { kind: 'signup', grant_reason: null, granted_micro_usd: 20_000_000, left_micro_usd: 5_000_000, granted_at: 1_791_072_000, expires_at: 1_793_836_800 },
    { kind: 'grant', grant_reason: 'on_request', granted_micro_usd: 20_000_000, left_micro_usd: 12_400_000, granted_at: 1_793_750_400, expires_at: 1_796_428_800 },
  ],
  expired_micro_usd: 0,
  free_model: { calls_today: 40, calls_per_day: 100, available: true },
  included_hours_withheld: false,
  network: { off: true, message: NETWORK },
  credit_request: { message: MORE_CREDIT, url: 'https://discord.gg/btTYzdzvqq' },
}

describe('WalletView', () => {
  it('shows a balance below zero as it is, and one line naming the minimum', () => {
    const { lastFrame } = render(<WalletView wallet={{ ...WALLET, balance_micro_usd: -600_000, paid_work_paused: true }} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('balance         -$0.60')
    expect(frame).toContain('paused under the $0.50 minimum, until a top-up')
    expect(frame.split(NOTE)).toHaveLength(2)
  })

  it('adds no line at zero or above', () => {
    expect(render(<WalletView wallet={WALLET} />).lastFrame()).not.toContain('below zero')
    expect(render(<WalletView wallet={{ ...WALLET, balance_micro_usd: 0, paid_work_paused: true }} />).lastFrame()).not.toContain('below zero')
  })

  it('says the plan\'s machine time in hours and when it resets', () => {
    // Pro: 10 hours included, 120 s used, the period ends 4 August.
    expect(render(<WalletView wallet={WALLET} />).lastFrame()).toContain('machine time    10 h included: 0 h used, resets 4 August')
  })

  it('adds no Free plan or granted credit line where the server sends none', () => {
    const frame = render(<WalletView wallet={WALLET} />).lastFrame() ?? ''
    for (const label of ['granted credit', 'paid credit', 'free model', 'network', 'more credit']) expect(frame).not.toContain(label)
  })

  it('prints the Free plan\'s lines as the design writes them', () => {
    const frame = (render(<WalletView wallet={FREE_WALLET} />).lastFrame() ?? '').replace(/\s+/g, ' ')
    expect(frame).toContain('WALLET · free plan')
    expect(frame).toContain('machine time 1 h included: 0.4 h used, resets 1 November')
    expect(frame).toContain('free model 40 of 100 calls today')
    expect(frame).toContain(`network off. ${NETWORK}`)
    expect(frame).toContain(`more credit ${MORE_CREDIT}`)
  })

  it('prints one line per grant, its last day, then the paid credit that never expires', () => {
    const lines = (render(<WalletView wallet={FREE_WALLET} />).lastFrame() ?? '').split('\n').map((line) => line.trim())
    expect(lines).toContain('granted credit  $5.00 left of $20.00, expires 4 Nov 2026')
    expect(lines).toContain('granted credit  $12.40 left of $20.00, expires 4 Dec 2026')
    expect(lines).toContain('paid credit     $18.20 (never expires)')
    // Soonest expiry first, as the server lists them.
    expect(lines.findIndex((l) => l.includes('4 Nov 2026'))).toBeLessThan(lines.findIndex((l) => l.includes('4 Dec 2026')))
  })

  it('says the included hour is used once it all is', () => {
    const frame = render(<WalletView wallet={{ ...FREE_WALLET, used_compute_seconds: 3_660 }} />).lastFrame() ?? ''
    expect(frame).toContain('machine time    1 h included: used, resets 1 November')
  })

  it('prints no network line once the network is on', () => {
    const frame = render(<WalletView wallet={{ ...FREE_WALLET, network: { off: false } }} />).lastFrame() ?? ''
    expect(frame).not.toContain('network')
  })
})
