import { describe, expect, it } from 'vitest'

import { formatCount, formatDate, formatTime } from '../src/lib/format.js'
import { usdCents, usdMicro } from '../src/lib/money.js'

describe('formatTime', () => {
  it('renders unix seconds at minute precision in UTC', () => {
    expect(formatTime(1_783_245_600)).toBe('2026-07-05 10:00')
  })

  it('renders a missing time as a dash', () => {
    expect(formatTime(null)).toBe('-')
    expect(formatTime(undefined)).toBe('-')
  })
})

describe('formatDate', () => {
  it('renders the UTC calendar day', () => {
    expect(formatDate(1_783_245_600)).toBe('2026-07-05')
  })
})

describe('formatCount', () => {
  it('compacts thousands and millions', () => {
    expect(formatCount(950)).toBe('950')
    expect(formatCount(1_250)).toBe('1.3k')
    expect(formatCount(3_400_000)).toBe('3.4M')
  })
})

// money-payments "Money display": the table both clients test, unchanged.
const MICRO_USD: [number, string][] = [
  [0, '$0.00'],
  [1, '$0.000001'],
  [47, '$0.000047'],
  [9990, '$0.00999'],
  [9999, '$0.009999'],
  [10000, '$0.01'],
  [14999, '$0.01'],
  [15000, '$0.02'],
  [12345678, '$12.35'],
  [1234567890, '$1,234.57'],
  [1000000000000, '$1,000,000.00'],
  [-47, '-$0.000047'],
  [-1500000, '-$1.50'],
]
const CENTS: [number, string][] = [
  [0, '$0.00'],
  [83, '$0.83'],
  [2000, '$20.00'],
]

describe('money display', () => {
  it.each(MICRO_USD)('%d micro-USD is %s', (micro, shown) => {
    expect(usdMicro(micro)).toBe(shown)
  })

  it.each(CENTS)('%d cents is %s', (cents, shown) => {
    expect(usdCents(cents)).toBe(shown)
  })
})
