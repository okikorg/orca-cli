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

describe('WalletView', () => {
  it('shows a balance below zero as it is, and one line naming the minimum', () => {
    const { lastFrame } = render(<WalletView wallet={{ ...WALLET, balance_micro_usd: -600_000, paid_work_paused: true }} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('balance     -$0.60')
    expect(frame).toContain('paused under the $0.50 minimum, until a top-up')
    expect(frame.split(NOTE)).toHaveLength(2)
  })

  it('adds no line at zero or above', () => {
    expect(render(<WalletView wallet={WALLET} />).lastFrame()).not.toContain('below zero')
    expect(render(<WalletView wallet={{ ...WALLET, balance_micro_usd: 0, paid_work_paused: true }} />).lastFrame()).not.toContain('below zero')
  })
})
