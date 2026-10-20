import { describe, expect, it } from 'vitest'

import { planActions, planColumn, planWord, planWords } from '../../src/lib/plan.js'
import type { PickModel } from '../../src/lib/types.js'

describe('the plan marks (free-plan D3.16)', () => {
  it('name the free model and the models that need Pro or Max, and nothing else', () => {
    expect(planWord('free')).toBe('free model')
    expect(planWord('pro_and_max')).toBe('Pro and Max')
    expect(planWord('within_ceiling')).toBeUndefined()
    expect(planWord(undefined)).toBeUndefined()
  })

  it('make a column only where the server marks a model', () => {
    const marked: PickModel[] = [{ id: 'a', plan: 'free' }, { id: 'b', plan: 'within_ceiling' }, { id: 'c', plan: 'pro_and_max' }]
    const [column] = planColumn(marked)
    expect(column.header).toBe('plan')
    expect(marked.map(column.get)).toEqual(['free model', '', 'Pro and Max'])
    // Pro and Max, or an older server: every model runs, no column.
    expect(planColumn([{ id: 'a', plan: 'within_ceiling' }, { id: 'b' }])).toEqual([])
  })
})

describe('a refusal\'s ways forward', () => {
  it('are the dashboard\'s, read from code and param', () => {
    expect(planActions('insufficient_quota', 'free_plan')).toEqual(['free_model', 'provider_key', 'add_credit', 'upgrade'])
    expect(planActions('model_not_in_plan', 'agent.model')).toEqual(['upgrade', 'free_model'])
    expect(planActions('insufficient_quota', 'free_model_capacity')).toEqual(['provider_key', 'upgrade'])
    expect(planActions('insufficient_quota', 'free_model_daily')).toEqual(['provider_key', 'upgrade'])
    expect(planActions('usage_limit_exceeded', 'free_model_capacity')).toEqual(['provider_key', 'upgrade'])
    expect(planActions('insufficient_quota', 'included_hours')).toEqual(['add_credit'])
    expect(planActions('usage_limit_exceeded', 'included_hours')).toEqual(['add_credit'])
    expect(planActions('free_model_unavailable', undefined)).toEqual(['provider_key', 'add_credit'])
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
