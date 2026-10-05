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

describe('usdMicro', () => {
  it('formats micro-USD as dollars and cents', () => {
    expect(usdMicro(20_000_000)).toBe('$20.00')
    expect(usdMicro(-1_500_000)).toBe('-$1.50')
    expect(usdMicro(0)).toBe('$0.00')
  })

  it('keeps sub-cent charges visible', () => {
    expect(usdMicro(400)).toBe('$0.0004')
    expect(usdMicro(8)).toBe('<$0.0001')
    expect(usdMicro(-8)).toBe('-<$0.0001')
  })
})

describe('usdCents', () => {
  it('formats cents as dollars', () => {
    expect(usdCents(2000)).toBe('$20.00')
  })
})
