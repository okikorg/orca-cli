// Model names and who pays (orca-design model-billing D3.13): the picker's
// groups for `agents create`, and the switch of who pays that `chat` offers
// when a credit runs out. Every list and price comes from the server; the
// only rule mirrored is how a name says who pays.

import { glyphs } from '../ui/theme.js'
import { percentBps, usdMicro } from './money.js'
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

// groupHeading names who pays for a group: Orca credit with OpenRouter's
// fee, or the provider that bills.
export function groupHeading(group: ModelGroup, feeBps: number): string {
  return group.payer === 'orca_credit'
    ? `Orca credit, plus OpenRouter's ${percentBps(feeBps)} fee`
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

export type ModelItem = { label: string; value: string; detail: string }

// pickerItems lists the groups' models for the terminal picker, in the
// server's order. The group (who pays) and the price go in each row's
// detail, since the picker has no headings.
export function pickerItems(list: ModelGroups, include: (group: ModelGroup) => boolean = () => true): ModelItem[] {
  return list.groups.filter(include).flatMap((group) => {
    const heading = groupHeading(group, list.openrouter_fee_bps)
    return group.models.map((model) => {
      const price = priceLine(model)
      return { label: model.id, value: model.id, detail: price ? `${heading} ${glyphs.separator} ${price}` : heading }
    })
  })
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
// for Orca credit (`insufficient_quota`).
export function creditOut(code: string | undefined, param: string | undefined): 'orca_credit' | 'provider_quota' | null {
  if (code === 'insufficient_quota') return 'orca_credit'
  if (code !== 'usage_limit_exceeded') return null
  if (param === 'orca_credit' || param === 'provider_quota') return param
  return null
}

// refusedAtAdmission is a message the server refused before any turn began:
// after a switch it is sent again, where a turn the server ended continues.
export function refusedAtAdmission(code: string | undefined): boolean {
  return code === 'insufficient_quota'
}
