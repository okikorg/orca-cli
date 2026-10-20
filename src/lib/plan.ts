// The Free plan's refusals and marks (orca-design free-plan D3.16). The
// server writes every message; the CLI adds only the ways forward the
// dashboard offers as buttons, here as words with the command for each.

import type { ModelPlan, PickModel } from './types.js'

// planWord is an Orca credit model's mark, as `orca models` and the pickers
// show it: the free model, a model that needs Pro or Max, or nothing.
export function planWord(plan: ModelPlan | undefined): string | undefined {
  if (plan === 'free') return 'free model'
  if (plan === 'pro_and_max') return 'Pro and Max'
  return undefined
}

// planColumn is a model table's plan column: present only where the server
// marks a model, so Pro and Max, where every model runs, show none.
export function planColumn(models: readonly PickModel[]): { header: string; get: (m: PickModel) => string }[] {
  return models.some((m) => planWord(m.plan)) ? [{ header: 'plan', get: (m) => planWord(m.plan) ?? '' }] : []
}

// A way forward from a refusal, as the dashboard names it.
export type PlanAction = 'free_model' | 'provider_key' | 'add_credit' | 'upgrade'

const ACTION_WORDS: Record<PlanAction, string> = {
  free_model: 'Switch this session to the free model (orca chat offers it at a terminal)',
  provider_key: 'Add a provider key: in the dashboard, Settings, Providers',
  add_credit: 'Add credit: orca billing buy pack:<cents> (orca billing wallet lists the packs)',
  upgrade: 'Upgrade: orca billing buy pro, or orca billing buy max',
}

// planActions reads a refusal's ways forward from the server's code and
// param, never its message: at turn admission (`model_not_in_plan`,
// `free_model_unavailable`, `insufficient_quota`) or a turn the server ended
// (`usage_limit_exceeded`). Empty for anything else.
export function planActions(code: string | null | undefined, param: string | null | undefined): PlanAction[] {
  if (code === 'model_not_in_plan') return ['upgrade', 'free_model']
  if (code === 'free_model_unavailable') return ['provider_key', 'add_credit']
  if (code !== 'insufficient_quota' && code !== 'usage_limit_exceeded') return []
  switch (param) {
    case 'free_plan':
      return ['free_model', 'provider_key', 'add_credit', 'upgrade']
    case 'free_model_capacity':
    case 'free_model_daily':
      return ['provider_key', 'upgrade']
    case 'included_hours':
      return ['add_credit']
    default:
      return []
  }
}

// planWords is the ways forward as lines, printed under the server's message.
export function planWords(code: string | null | undefined, param: string | null | undefined): string[] {
  return planActions(code, param).map((action) => ACTION_WORDS[action])
}
