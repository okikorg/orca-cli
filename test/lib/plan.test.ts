import { describe, expect, it } from 'vitest'

import { freeModelNotInPlan, planActions, planColumn, planWord, planWords } from '../../src/lib/plan.js'
import type { PickModel } from '../../src/lib/types.js'

describe('the plan marks (free-plan D3.16)', () => {
  it('name the free model, and nothing else: Free has no price ceiling (2026-10-22)', () => {
    expect(planWord('free')).toBe('free model')
    // The server sends pro_and_max only with a ceiling in Free's terms: no mark.
    expect(planWord('pro_and_max')).toBeUndefined()
    expect(planWord('within_ceiling')).toBeUndefined()
    expect(planWord(undefined)).toBeUndefined()
  })

  it('make a column only where a free model is listed', () => {
    const marked: PickModel[] = [{ id: 'a', plan: 'free' }, { id: 'b', plan: 'within_ceiling' }, { id: 'c', plan: 'pro_and_max' }]
    const [column] = planColumn(marked)
    expect(column.header).toBe('plan')
    expect(marked.map(column.get)).toEqual(['free model', '', ''])
    // No free model listed, or an older server: no column.
    expect(planColumn([{ id: 'a', plan: 'within_ceiling' }, { id: 'b', plan: 'pro_and_max' }, { id: 'c' }])).toEqual([])
  })
})

describe('a refusal\'s ways forward', () => {
  it('are the dashboard\'s, read from code and param', () => {
    expect(planActions('insufficient_quota', 'free_plan')).toEqual(['free_model', 'provider_key', 'add_credit', 'upgrade'])
    expect(planActions('model_not_in_plan', 'agent.model')).toEqual(['upgrade', 'free_model'])
    // Shared by every tier, so never upgrade (amendment A6 (6)).
    expect(planActions('insufficient_quota', 'free_model_capacity')).toEqual(['openrouter_key', 'add_credit'])
    expect(planActions('insufficient_quota', 'free_model_daily')).toEqual(['openrouter_key', 'add_credit'])
    expect(planActions('usage_limit_exceeded', 'free_model_capacity')).toEqual(['openrouter_key', 'add_credit'])
    expect(planActions('free_model_unavailable', undefined)).toEqual(['openrouter_key', 'add_credit'])
  })

  it('offer no credit for Free\'s included machine time, which credit buys only while Free has a rate (amendment A6 (15))', () => {
    expect(planActions('insufficient_quota', 'included_hours')).toEqual([])
    expect(planActions('usage_limit_exceeded', 'included_hours')).toEqual([])
  })

  it('cover the Free plan\'s rate limits by their param (amendment A2), and no other rate limit', () => {
    expect(planWords('rate_limit_exceeded', 'free_model_busy')).toEqual([
      'Try again in a minute',
      'Add your own OpenRouter key: in the dashboard, Settings, Providers',
    ])
    expect(planWords('rate_limit_exceeded', 'turns_per_day')).toEqual([
      'More at 00:00 UTC',
      'Upgrade: orca billing buy pro, or orca billing buy max',
    ])
    expect(planWords('rate_limit_exceeded', 'free_sandboxes_busy')).toEqual([
      'Try again in a few minutes',
      'Upgrade: orca billing buy pro, or orca billing buy max',
    ])
    // Sessions at once, sandboxes at once, requests a minute: unchanged.
    expect(planActions('rate_limit_exceeded', undefined)).toEqual([])
  })

  it('tell a free model on a plan with no share from any other model by the session\'s model (amendment A5)', () => {
    const free = 'orca/openrouter/cohere/north-mini-code:free'
    expect(freeModelNotInPlan('model_not_in_plan', free)).toBe(true)
    expect(freeModelNotInPlan('model_not_in_plan', 'orca/openrouter/anthropic/claude-fable-5')).toBe(false)
    expect(freeModelNotInPlan('model_not_in_plan', undefined)).toBe(false)
    // Own OpenRouter keys run `:free` models as before.
    expect(freeModelNotInPlan('model_not_in_plan', 'openrouter/cohere/north-mini-code:free')).toBe(false)
    expect(freeModelNotInPlan('free_model_unavailable', free)).toBe(false)
    expect(planWords('model_not_in_plan', 'agent.model', free)).toEqual(['Add your own OpenRouter key: in the dashboard, Settings, Providers'])
    expect(planActions('model_not_in_plan', 'agent.model', 'orca/openrouter/anthropic/claude-fable-5')).toEqual(['upgrade', 'free_model'])
  })

  it('switch a withdrawn free model to the next one only while the server lists one (amendments A3 (3), A5)', () => {
    // Another free model listed: the switch to it comes first.
    expect(planActions('free_model_unavailable', 'agent.model', undefined, true)).toEqual(['free_model', 'openrouter_key', 'add_credit'])
    // None listed: the free models are off, and the server's message says so.
    expect(planActions('free_model_unavailable', 'agent.model', undefined, false)).toEqual(['openrouter_key', 'add_credit'])
    expect(planActions('free_model_unavailable', 'agent.model')).toEqual(['openrouter_key', 'add_credit'])
    expect(planWords('free_model_unavailable', 'agent.model', undefined, true)[0]).toBe(
      'Switch this session to the free model (orca chat offers it at a terminal)',
    )
  })

  it('are none for every other refusal', () => {
    expect(planActions('insufficient_quota', undefined)).toEqual([])
    expect(planActions('usage_limit_exceeded', 'orca_credit')).toEqual([])
    expect(planActions('rate_limit_exceeded', 'free_plan')).toEqual([])
    expect(planActions(null, null)).toEqual([])
  })

  it('are words with the command for each', () => {
    expect(planWords('insufficient_quota', 'free_plan')).toEqual([
      'Switch this session to the free model (orca chat offers it at a terminal)',
      'Add a provider key: in the dashboard, Settings, Providers',
      'Add credit: orca billing buy pack:<cents> (orca billing wallet lists the packs)',
      'Upgrade: orca billing buy pro, or orca billing buy max',
    ])
  })
})
