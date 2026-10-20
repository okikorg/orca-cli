import { describe, expect, it } from 'vitest'

import { formatCount, formatDate, formatDayMonth, formatDayShort, formatHours, formatTime } from '../src/lib/format.js'
import { belowZeroNote, usdCents, usdMicro } from '../src/lib/money.js'

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

describe('the wallet\'s dates and hours (free-plan D3.16)', () => {
  it('render a reset day as day and month, and a grant\'s day with the year, in UTC', () => {
    // 2026-11-01 00:00 UTC, when Free's October period resets.
    expect(formatDayMonth(1_793_491_200)).toBe('1 November')
    // 2026-12-04 23:59:59 UTC.
    expect(formatDayShort(1_796_428_799)).toBe('4 Dec 2026')
  })
  it('render hours to a tenth, rounded down, with thousands', () => {
    expect(formatHours(3_600)).toBe('1 h')
    expect(formatHours(1_440)).toBe('0.4 h')
    expect(formatHours(3_599)).toBe('0.9 h')
    expect(formatHours(0)).toBe('0 h')
    expect(formatHours(216_000)).toBe('60 h')
    expect(formatHours(3_600_000)).toBe('1,000 h')
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
  [-600000, '-$0.60'],
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

describe('belowZeroNote', () => {
  it('names the minimum when the balance is below zero, and is silent at zero or above', () => {
    expect(belowZeroNote(-600_000, 500_000)).toBe('Your balance is below zero. Paid work resumes when credit brings it to $0.50.')
    expect(belowZeroNote(-1, 5_000_000)).toBe('Your balance is below zero. Paid work resumes when credit brings it to $5.00.')
    expect(belowZeroNote(0, 500_000)).toBeNull()
    expect(belowZeroNote(250_000, 500_000)).toBeNull()
  })
})
