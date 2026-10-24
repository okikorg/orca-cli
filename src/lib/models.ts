// Model names and who pays (orca-design model-billing D3.13): the picker's
// groups for `agents create`, and the switch of who pays that `chat` offers
// when a credit runs out. Every list and price comes from the server; the
// only rule mirrored is how a name says who pays.

import { glyphs } from '../ui/theme.js'
import { CliError, ExitCode } from './errors.js'
import { tokenPrice, usdMicro } from './money.js'
import { freeModelNotInPlan, planActions, planWord } from './plan.js'
import type { ModelGroup, ModelGroups, Payer, PickModel } from './types.js'

const ORCA_PREFIX = 'orca/openrouter/'

// payerOf reads who pays from a model name: `orca/openrouter/<id>` is Orca
// credit, `<provider>/<id>` the tenant's own key. A name that says neither
// is null; the server refuses it.
export function payerOf(model: string): Payer | null {
  if (model.startsWith(ORCA_PREFIX)) return model.length > ORCA_PREFIX.length ? 'orca_credit' : null
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return null
  return model.startsWith('orca/') ? null : 'own_key'
}

// counterpart is the same model on the other side of who pays, when one
// exists by name: `orca/openrouter/<id>` and `openrouter/<id>` are one
// OpenRouter model. Every other name has none; no name map is kept.
export function counterpart(model: string): string | null {
  if (model.startsWith(ORCA_PREFIX)) return `openrouter/${model.slice(ORCA_PREFIX.length)}`
  if (model.startsWith('openrouter/')) return `orca/${model}`
  return null
}

// The warning shown before a switch, verbatim from the design.
export const SWITCH_WARNING =
  "Switching may re-send this conversation without the provider's cache, which uses more tokens. The model may behave differently through another route, and work in progress may not carry over correctly."

// groupHeading names who pays for a group: Orca credit at OpenRouter's price
// plus their fee, or the provider that bills.
export function groupHeading(group: ModelGroup, feeBps: number): string {
  return group.payer === 'orca_credit'
    ? `Orca credit, ${tokenPrice(feeBps)}`
    : `${group.label}, billed by your provider`
}

// priceLine is OpenRouter's price for an Orca credit model, formatted only.
export function priceLine(model: PickModel): string | undefined {
  const input = model.input_micro_usd_per_million
  const output = model.output_micro_usd_per_million
  if (input === undefined && output === undefined) return undefined
  const price = (micro: number | null | undefined) => (micro == null ? 'varies' : usdMicro(micro))
  return `${price(input)} in, ${price(output)} out per million tokens`
}

// payerWord is who pays for a group in one word, as `orca models --payer`
// takes it: `orca` for Orca credit, else the provider whose key pays.
export function payerWord(group: ModelGroup): string {
  return group.payer === 'orca_credit' ? 'orca' : group.provider
}

// withPayer keeps the groups one payer pays for, in the server's body. No
// payer keeps them all; a payer the server did not return is a usage error
// naming the ones it did.
export function withPayer(list: ModelGroups, payer?: string): ModelGroups {
  if (payer === undefined) return list
  const groups = list.groups.filter((group) => payerWord(group) === payer)
  if (groups.length === 0) {
    const known = list.groups.map(payerWord)
    throw new CliError(`no models paid by "${payer}"`, ExitCode.Usage, [
      known.length ? `Payers: ${known.join(', ')}` : 'The server returned no models.',
    ])
  }
  return { ...list, groups }
}

// ModelRow is one model as a flat row: its name, who pays in one word,
// OpenRouter's price where the server gives one, and what the plan allows
// of an Orca credit model (free-plan D3.16).
export type ModelRow = {
  id: string
  payer: string
  input_micro_usd_per_million?: number | null
  output_micro_usd_per_million?: number | null
  plan?: PickModel['plan']
}

// modelRows flattens the groups into rows, in the server's order, keeping
// the names that contain `query` (any case) when one is given.
export function modelRows(list: ModelGroups, query?: string): ModelRow[] {
  const needle = query?.trim().toLowerCase()
  return list.groups.flatMap((group) =>
    group.models
      .filter((m) => !needle || m.id.toLowerCase().includes(needle))
      .map((m) => ({
        id: m.id,
        payer: payerWord(group),
        ...(m.input_micro_usd_per_million !== undefined ? { input_micro_usd_per_million: m.input_micro_usd_per_million } : {}),
        ...(m.output_micro_usd_per_million !== undefined ? { output_micro_usd_per_million: m.output_micro_usd_per_million } : {}),
        ...(m.plan !== undefined ? { plan: m.plan } : {}),
      })),
  )
}

export type ModelItem = { label: string; value: string; detail: string; disabled?: boolean }

// pickerItems lists the groups' models for the terminal picker, in the
// server's order. The group (who pays), the price and the plan's mark go in
// each row's detail, since the picker has no headings. A model above Free's
// ceiling is shown and cannot be picked (A12 (6)).
export function pickerItems(list: ModelGroups, include: (group: ModelGroup) => boolean = () => true): ModelItem[] {
  return list.groups.filter(include).flatMap((group) => {
    const heading = groupHeading(group, list.openrouter_fee_bps)
    return group.models.map((model) => {
      const detail = [heading, priceLine(model), planWord(model.plan)].filter(Boolean).join(` ${glyphs.separator} `)
      return { label: model.id, value: model.id, detail, ...(model.plan === 'pro_and_max' ? { disabled: true } : {}) }
    })
  })
}

// freeModels is the Orca credit models the server marks as a free model,
// which it does on every tier with a share (free-plan D3.16, F16, amendment
// A4) and on none while they are off (A5): the list itself is the server's,
// from its plan facts, never typed here.
export function freeModels(list: ModelGroups): string[] {
  return list.groups
    .filter((group) => group.payer === 'orca_credit')
    .flatMap((group) => group.models.filter((model) => model.plan === 'free').map((model) => model.id))
}

// freeFirst puts the free models' rows first, in the server's order
// otherwise, so a picker on Free offers the free model first.
export function freeFirst(items: readonly ModelItem[], free: readonly string[]): ModelItem[] {
  return [...items.filter((item) => free.includes(item.value)), ...items.filter((item) => !free.includes(item.value))]
}

// otherSide is the groups a switch from `payer` can pick from.
export function otherSide(list: ModelGroups, payer: Payer | null): ModelGroup[] {
  return list.groups.filter((group) => group.payer !== payer)
}

// preselect is the model a switch starts on: the same OpenRouter model on
// the other side, when that side lists it. Exact or nothing.
export function preselect(groups: readonly ModelGroup[], model: string): string | undefined {
  const same = counterpart(model)
  return same && groups.some((group) => group.models.some((m) => m.id === same)) ? same : undefined
}

// creditOut names the credit that ran out, from the server's code and
// param, never its message: a turn it ended (`usage_limit_exceeded` with
// `orca_credit` or `provider_quota`), or a message it refused at admission
// for Orca credit (`insufficient_quota`). Free's included machine time used
// up (`included_hours`) is machine time, which no switch of model pays for.
export function creditOut(code: string | undefined, param: string | undefined): 'orca_credit' | 'provider_quota' | null {
  if (code === 'insufficient_quota') return param === 'included_hours' ? null : 'orca_credit'
  if (code !== 'usage_limit_exceeded') return null
  if (param === 'orca_credit' || param === 'provider_quota') return param
  return null
}

// SwitchCause is why a session is offered a switch of model: a credit ran
// out, or the plan refused the model at admission (free-plan D3.16): a model
// not in the organization's plan, or a free model withdrawn while another is
// listed (amendment A3 (3)). Neither plan refusal is a credit refusal, so
// neither offers a top-up.
export type SwitchCause = 'orca_credit' | 'provider_quota' | 'model_not_in_plan' | 'free_model_unavailable'

// switchCause is the switch a refusal offers, or null for none. `model` and
// `freeModel` are as planActions reads them: a free model on a tier with no
// share (A5), or the free models off (no free model listed), offers no
// switch; the server's message and its ways say what to do.
export function switchCause(
  code: string | undefined,
  param: string | undefined,
  model?: string,
  freeModel = false,
): SwitchCause | null {
  if (code === 'model_not_in_plan') return freeModelNotInPlan(code, model) ? null : 'model_not_in_plan'
  if (code === 'free_model_unavailable') return freeModel ? 'free_model_unavailable' : null
  return creditOut(code, param)
}

// refusedAtAdmission is a message the server refused before any turn began:
// after a switch it is sent again, where a turn the server ended continues.
export function refusedAtAdmission(code: string | undefined): boolean {
  return code === 'insufficient_quota' || code === 'model_not_in_plan' || code === 'free_model_unavailable'
}

// offersFreeModel is a refusal whose ways forward include switching this
// session to the free model (free-plan D3.16, F16): the switch then lists
// the free model first. `model` and `freeModel` are as planActions reads
// them.
export function offersFreeModel(code: string | undefined, param: string | undefined, model?: string, freeModel = false): boolean {
  return planActions(code, param, model, freeModel).includes('free_model')
}
