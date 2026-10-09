import { describe, expect, it } from 'vitest'

import { counterpart, creditOut, otherSide, payerOf, pickerItems, preselect, refusedAtAdmission } from '../../src/lib/models.js'
import { percentBps } from '../../src/lib/money.js'
import type { ModelGroups } from '../../src/lib/types.js'
import { glyphs } from '../../src/ui/theme.js'

// A GET /api/models answer: Orca credit with OpenRouter's prices, then the
// organization's own OpenRouter and Anthropic keys.
const LIST: ModelGroups = {
  object: 'list',
  openrouter_fee_bps: 550,
  groups: [
    {
      payer: 'orca_credit',
      provider: 'openrouter',
      label: 'Orca credit',
      available: true,
      models: [
        { id: 'orca/openrouter/openai/gpt-5.6-luna', input_micro_usd_per_million: 200_000, output_micro_usd_per_million: 1_200_000 },
        { id: 'orca/openrouter/openrouter/auto', input_micro_usd_per_million: null, output_micro_usd_per_million: null },
      ],
    },
    { payer: 'own_key', provider: 'openrouter', label: 'OpenRouter', available: true, models: [{ id: 'openrouter/openai/gpt-5.6-luna' }] },
    { payer: 'own_key', provider: 'anthropic', label: 'Anthropic', available: true, models: [{ id: 'anthropic/claude-sonnet-4-5' }] },
  ],
}

describe('model names', () => {
  it('say who pays: orca/openrouter/<id> is Orca credit, <provider>/<id> an own key, the rest nothing', () => {
    expect(payerOf('orca/openrouter/openai/gpt-5.6-luna')).toBe('orca_credit')
    expect(payerOf('anthropic/claude-sonnet-4-5')).toBe('own_key')
    for (const model of ['gpt-5', 'orca/openrouter/', 'orca/anthropic/x', 'anthropic/']) expect(payerOf(model)).toBeNull()
  })
  it('have a counterpart only for the same OpenRouter model', () => {
    expect(counterpart('orca/openrouter/x/y')).toBe('openrouter/x/y')
    expect(counterpart('openrouter/x/y')).toBe('orca/openrouter/x/y')
    expect(counterpart('anthropic/claude-sonnet-4-5')).toBeNull()
  })
})

describe('the model picker', () => {
  it('lists every group in order, with who pays and the price in each row', () => {
    const sep = glyphs.separator
    expect(pickerItems(LIST)).toEqual([
      {
        label: 'orca/openrouter/openai/gpt-5.6-luna',
        value: 'orca/openrouter/openai/gpt-5.6-luna',
        detail: `Orca credit, plus OpenRouter's 5.5% fee ${sep} $0.20 in, $1.20 out per million tokens`,
      },
      {
        label: 'orca/openrouter/openrouter/auto',
        value: 'orca/openrouter/openrouter/auto',
        detail: `Orca credit, plus OpenRouter's 5.5% fee ${sep} varies in, varies out per million tokens`,
      },
      { label: 'openrouter/openai/gpt-5.6-luna', value: 'openrouter/openai/gpt-5.6-luna', detail: 'OpenRouter, billed by your provider' },
      { label: 'anthropic/claude-sonnet-4-5', value: 'anthropic/claude-sonnet-4-5', detail: 'Anthropic, billed by your provider' },
    ])
  })
  it('formats the fee from basis points, without arithmetic on money', () => {
    expect(percentBps(550)).toBe('5.5%')
    expect(percentBps(600)).toBe('6%')
    expect(percentBps(5)).toBe('0.05%')
  })
})

describe('the switch', () => {
  it('offers the other side and preselects only the same OpenRouter model', () => {
    const toOwn = otherSide(LIST, 'orca_credit')
    expect(toOwn.map((g) => g.provider)).toEqual(['openrouter', 'anthropic'])
    expect(preselect(toOwn, 'orca/openrouter/openai/gpt-5.6-luna')).toBe('openrouter/openai/gpt-5.6-luna')
    expect(preselect(toOwn, 'orca/openrouter/openrouter/auto')).toBeUndefined()
    const toOrca = otherSide(LIST, 'own_key')
    expect(preselect(toOrca, 'openrouter/openai/gpt-5.6-luna')).toBe('orca/openrouter/openai/gpt-5.6-luna')
    expect(preselect(toOrca, 'anthropic/claude-sonnet-4-5')).toBeUndefined()
  })
  it('knows which credit ran out from code and param, never the message', () => {
    expect(creditOut('usage_limit_exceeded', 'orca_credit')).toBe('orca_credit')
    expect(creditOut('usage_limit_exceeded', 'provider_quota')).toBe('provider_quota')
    expect(creditOut('usage_limit_exceeded', undefined)).toBeNull()
    expect(creditOut('server_error', 'orca_credit')).toBeNull()
    // A message refused at admission for Orca credit.
    expect(creditOut('insufficient_quota', undefined)).toBe('orca_credit')
    expect(refusedAtAdmission('insufficient_quota')).toBe(true)
    expect(refusedAtAdmission('usage_limit_exceeded')).toBe(false)
  })
})
