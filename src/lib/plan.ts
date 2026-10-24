// The Free plan's refusals and marks (orca-design free-plan D3.16). The
// server writes every message; the CLI adds only the ways forward the
// dashboard offers as buttons, here as words with the command for each.

import { DEFAULT_DASHBOARD_URL } from './defaults.js'
import type { ModelGroups, ModelPlan, PickModel } from './types.js'

// planWord is an Orca credit model's mark, as `orca models` and the pickers
// show it: a free model (on every tier with a share, amendment A4), a model
// above Free's price ceiling, which Free lists but does not run (A12 (6)),
// or nothing.
export function planWord(plan: ModelPlan | undefined): string | undefined {
  return plan === 'free' ? 'free model' : plan === 'pro_and_max' ? 'Pro and Max' : undefined
}

// needsCreditLine is the line under a list the server cut to the free
// models because the organization is on Free without credit (A12 (4)):
// the dashboard's Wallet, or the CLI's own wallet with no dashboard set.
export function needsCreditLine(list: ModelGroups, dashboardUrl?: string | null): string | undefined {
  const cut = list.groups.some((group) => group.payer === 'orca_credit' && group.needs_credit === true)
  if (!cut) return undefined
  const dashboard = dashboardUrl ?? DEFAULT_DASHBOARD_URL
  return `Add credit to use other models: ${dashboard ? `${dashboard.replace(/\/+$/, '')}/wallet` : 'orca billing wallet'}`
}

// planColumn is a model table's plan column: present only where a model is
// marked. The free models are marked on every tier (amendment A4); with
// them off or on a tier with no share (A5), and nothing above a ceiling,
// there is no column.
export function planColumn(models: readonly PickModel[]): { header: string; get: (m: PickModel) => string }[] {
  return models.some((m) => planWord(m.plan)) ? [{ header: 'plan', get: (m) => planWord(m.plan) ?? '' }] : []
}

// A way forward from a refusal, as the dashboard names it.
export type PlanAction =
  | 'free_model'
  | 'provider_key'
  | 'openrouter_key'
  | 'add_credit'
  | 'upgrade'
  | 'retry_minute'
  | 'retry_minutes'
  | 'next_day'

const ACTION_WORDS: Record<PlanAction, string> = {
  free_model: 'Switch this session to the free model (orca chat offers it at a terminal)',
  provider_key: 'Add a provider key: in the dashboard, Settings, Providers',
  openrouter_key: 'Add your own OpenRouter key: in the dashboard, Settings, Providers',
  add_credit: 'Add credit: orca billing buy pack:<cents> (orca billing wallet lists the packs)',
  upgrade: 'Upgrade: orca billing buy pro, or orca billing buy max',
  retry_minute: 'Try again in a minute',
  retry_minutes: 'Try again in a few minutes',
  next_day: 'More at 00:00 UTC',
}

// freeModelNotInPlan is a 403 `model_not_in_plan` on one of Orca's free
// models: its tier's free-model share is none or 0 (amendment A5). Any
// other model refused with this code is the plan's own refusal, with the
// same code and param, so the session's model tells them apart. Orca credit refuses a `:free`
// model off the list before this (400, or 503 while the list is empty), so
// a `:free` model here is a listed one.
export function freeModelNotInPlan(code: string | null | undefined, model: string | undefined): boolean {
  return code === 'model_not_in_plan' && model !== undefined && model.startsWith('orca/') && model.endsWith(':free')
}

// planActions reads a refusal's ways forward from the server's code and
// param, never its message: at turn admission (`model_not_in_plan`,
// `free_model_unavailable`, `insufficient_quota`, and the Free plan's
// `rate_limit_exceeded` params, amendment A2) or a turn the server ended
// (`usage_limit_exceeded`). Empty for anything else, the other rate limits
// included. `model` is the session's model where the caller knows it, which
// tells a free model on a tier with no share from any other model (A5).
// `freeModel` is whether the server lists a free model that can run now,
// where the caller read it.
export function planActions(
  code: string | null | undefined,
  param: string | null | undefined,
  model?: string,
  freeModel = false,
): PlanAction[] {
  if (code === 'model_not_in_plan') return freeModelNotInPlan(code, model) ? ['openrouter_key'] : ['upgrade', 'free_model']
  // A free model withdrawn or repriced: the switch goes to the next one the
  // server lists (amendment A3 (3)). With none listed, the free models are
  // off (A5) and the server's message says so: no switch to offer.
  if (code === 'free_model_unavailable') {
    return freeModel ? ['free_model', 'openrouter_key', 'add_credit'] : ['openrouter_key', 'add_credit']
  }
  if (code === 'rate_limit_exceeded') {
    switch (param) {
      case 'free_model_busy':
        return ['retry_minute', 'openrouter_key']
      case 'turns_per_day':
        return ['next_day', 'upgrade']
      case 'free_sandboxes_busy':
        return ['retry_minutes', 'upgrade']
      default:
        return []
    }
  }
  if (code !== 'insufficient_quota' && code !== 'usage_limit_exceeded') return []
  switch (param) {
    case 'free_plan':
      return ['free_model', 'provider_key', 'add_credit', 'upgrade']
    // Every tier shares the capacity and has the same share, so upgrading
    // gives no more (amendment A6 (6)); the server's message, one of three
    // for the daily share (A6 (32)), says which ran out.
    case 'free_model_capacity':
    case 'free_model_daily':
      return ['openrouter_key', 'add_credit']
    // Free's included machine time: credit buys more only while Free's terms
    // give it a rate (amendment A6 (14), (15)), which the refusal does not
    // carry; the server's message offers credit exactly when it does.
    case 'included_hours':
    default:
      return []
  }
}

// planWords is the ways forward as lines, printed under the server's message.
export function planWords(
  code: string | null | undefined,
  param: string | null | undefined,
  model?: string,
  freeModel = false,
): string[] {
  return planActions(code, param, model, freeModel).map((action) => ACTION_WORDS[action])
}
