import { describe, expect, it } from 'vitest'

import { sessionUsageRows } from '../../src/lib/sessions.js'
import type { UsageSummary } from '../../src/lib/types.js'
import { eventCost, groupCost, groupRows } from '../../src/lib/usage.js'

// A session that searched, grouped by model, as the server sends it (server
// fix/usage-cost, test fixtures): two agent calls of 35 micro-USD, the
// search's call 1,241 and the search 10,550 on one model, a worker's call
// of 35 on another, and machine time with no model. Token rows are at
// cost 0: the money is on the call and search rows.
const SESSION: UsageSummary = {
  object: 'usage.summary',
  start: 0,
  end: 100,
  session_id: 'sess_1',
  cost_micro_usd: 70 + 1_241 + 10_550 + 35 + 500,
  meters: [
    { meter: 'model_tokens', unit: 'tokens', quantity: 70, cost_micro_usd: 0, buckets: {} },
    { meter: 'model_calls', unit: 'calls', quantity: 4, cost_micro_usd: 70 + 1_241 + 35, buckets: {} },
    { meter: 'web_searches', unit: 'searches', quantity: 1, cost_micro_usd: 10_550, buckets: {} },
    { meter: 'compute_seconds', unit: 'seconds', quantity: 60, cost_micro_usd: 500, buckets: {} },
  ],
  series: null,
  groups: [
    { meter: 'model_tokens', key: 'model-a', quantity: 60, cost_micro_usd: 0 },
    { meter: 'model_tokens', key: 'model-b', quantity: 10, cost_micro_usd: 0 },
    { meter: 'model_calls', key: 'model-a', quantity: 3, cost_micro_usd: 70 + 1_241 },
    { meter: 'web_searches', key: 'model-a', quantity: 1, cost_micro_usd: 10_550 },
    { meter: 'model_calls', key: 'model-b', quantity: 1, cost_micro_usd: 35 },
    { meter: 'compute_seconds', key: null, quantity: 60, cost_micro_usd: 500 },
  ],
  group_costs: [
    { key: 'model-a', cost_micro_usd: 11_861 },
    { key: null, cost_micro_usd: 500 },
    { key: 'model-b', cost_micro_usd: 35 },
  ],
}

describe('groupRows', () => {
  it('costs each key from group_costs, not from its token rows, and sums to the total', () => {
    const rows = groupRows(SESSION)
    expect(rows).toEqual([
      { key: 'model-a', tokens: 60, cost: 11_861 },
      { key: null, tokens: 0, cost: 500 },
      { key: 'model-b', tokens: 10, cost: 35 },
    ])
    expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBe(SESSION.cost_micro_usd)
  })

  it('leaves out a key with neither tokens nor cost', () => {
    const rows = groupRows({ ...SESSION, group_costs: [...SESSION.group_costs!, { key: 'idle', cost_micro_usd: 0 }] })
    expect(rows.map((row) => row.key)).not.toContain('idle')
  })
})

describe('groupCost', () => {
  it("reads one key's cost across every meter", () => {
    expect(groupCost(SESSION, 'model-b')).toBe(35)
    expect(groupCost(SESSION, 'missing')).toBeUndefined()
  })
})

describe('eventCost', () => {
  it('shows a charge by the money display rule and says where other money is', () => {
    expect(eventCost({ cost_micro_usd: 35, charged_on: null })).toBe('$0.000035')
    expect(eventCost({ cost_micro_usd: 0, charged_on: 'call' })).toBe('on its call')
    expect(eventCost({ cost_micro_usd: 0, charged_on: 'search' })).toBe('on its search')
    expect(eventCost({ cost_micro_usd: 0 })).toBe('$0.00')
  })
})

describe('sessionUsageRows', () => {
  it("shows each model's whole cost, its search included, not its tokens' cost of 0", () => {
    const shown = Object.fromEntries(sessionUsageRows(SESSION).map((row) => [row.key, row.shown]))
    // A cent or more shows rounded to the cent (the money display rule).
    expect(shown.cost).toBe('$0.01')
    expect(shown['model_tokens:model-a']).toBe('60 tokens, $0.01')
    expect(shown['model_tokens:model-b']).toBe('10 tokens, $0.000035')
    expect(shown.web_searches).toBe('1 searches, $0.01')
    expect(shown.model_calls).toBe('4 calls, $0.001346')
  })

  it('lists no row for a token group with no model', () => {
    const rows = sessionUsageRows({ ...SESSION, groups: [...SESSION.groups!, { meter: 'model_tokens', key: null, quantity: 5, cost_micro_usd: 0 }] })
    expect(rows.map((row) => row.key)).not.toContain('model_tokens:null')
    expect(rows.map((row) => row.key)).not.toContain('model_tokens:unknown')
  })
})
