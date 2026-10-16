import { describe, expect, it } from 'vitest'

import { fitResult } from '../../src/mcp/results.js'

const MAX = 2_000
const fit = (value: unknown, full?: string) => {
  const text = fitResult(value, full, MAX)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX)
  return JSON.parse(text)
}

describe('fitResult', () => {
  it('passes a value under the cap through unchanged', () => {
    const value = { id: 'a', items: [1, 2, 3] }
    expect(fitResult(value, undefined, MAX)).toBe(JSON.stringify(value, null, 1))
  })

  it('shortens the one item of a page that cannot fit whole, and still points past it', () => {
    const page = { items: [{ id: 'one', body: 'x'.repeat(5_000) }, { id: 'two', body: 'y' }], hasMore: false, lastId: 'two' }
    const out = fit(page, 'get_thing returns it whole')
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(['one'])
    expect(out).toMatchObject({ hasMore: true, lastId: 'one' })
    expect(out.truncated).toBe(`1 of 2 items fit in ${MAX} bytes; pass after: "one" for the rest`)
    expect(out.items[0].body).toMatch(/^x+\.\.\. \[shortened from 5000 characters\]$/)
    expect(out.shortened).toContain('get_thing returns it whole')
  })

  it('cuts the largest array of a value made of short strings, saying how many entries went', () => {
    const value = { days: Array.from({ length: 500 }, (_, i) => `day ${i}`), total: 7 }
    const out = fit(value)
    expect(out.total).toBe(7)
    const marker = out.days.at(-1) as string
    const lost = Number(/^\[cut (\d+) more entries to fit; narrow the request\]$/.exec(marker)?.[1])
    expect(out.days.length - 1 + lost).toBe(500)
    expect(out.days[0]).toBe('day 0')
  })

  it('shortens a long top-level string', () => {
    expect(fit('z'.repeat(10_000))).toMatch(/^z+\.\.\. \[shortened from 10000 characters\]$/)
  })
})
