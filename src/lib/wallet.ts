// The wallet's Free plan and granted credit lines (orca-design free-plan
// D3.16, "What a person sees", CLI), shared by the panel at a terminal and
// the plain rows. Every figure and message is the server's; the CLI only
// formats them.

import { formatDayMonth, formatDayShort, formatHours } from './format.js'
import { stripControlSequences } from './markdown.js'
import { usdMicro } from './money.js'
import type { GrantedCredit, Wallet } from './types.js'

// WITHHELD is the line a wallet adds when Free's included machine time and
// free model are withheld from the organization (free-plan F27, amendment
// A2 (3)). A copy of the server's WITHHELD_MESSAGE, kept because the wallet
// sends only the boolean `included_hours_withheld`, never the words.
export const WITHHELD =
  "Free's included hour and free model are not available for this organization. Add credit, or bring your own provider key."

// machineTime is the period's included machine time and how much is used:
// "1 h included: 0.4 h used, resets 1 November", or "used" once it all is;
// "not included for this organization" when it is withheld.
export function machineTime(w: Wallet): string {
  if (w.included_hours_withheld) return 'not included for this organization'
  const used = w.used_compute_seconds >= w.included_compute_seconds ? 'used' : `${formatHours(w.used_compute_seconds)} used`
  return `${formatHours(w.included_compute_seconds)} included: ${used}, resets ${formatDayMonth(w.period_end)}`
}

// freeModelCalls is the free model's calls today against the share, on
// every tier with one (free-plan amendment A4): "40 of 100 calls today".
// Null on a tier with no share, and while the free models are off (A5).
export function freeModelCalls(w: Wallet): string | null {
  const today = w.free_model_today
  if (!today || w.free_model?.models.length === 0) return null
  return `${today.calls_today} of ${today.calls_per_day} calls today`
}

// networkLine is the network line: "off." and the server's message while
// Free sandboxes have none; "on." and its message while running sandboxes
// still lack it once the organization has credit (amendment A6 (28)). Null
// when the network is on with nothing to say.
export function networkLine(w: Wallet): string | null {
  const network = w.network
  if (!network || (!network.off && !network.message)) return null
  return `${network.off ? 'off.' : 'on.'} ${stripControlSequences(network.message ?? '')}`.trimEnd()
}

// creditRequest is where a Free organization asks for credit, in the
// server's words. Null on Pro and Max.
export function creditRequest(w: Wallet): string | null {
  return w.credit_request ? stripControlSequences(w.credit_request.message) : null
}

// grantLastDay is the last UTC day a grant can be spent: expires_at is
// 00:00 UTC the day after it.
export function grantLastDay(grant: GrantedCredit): number {
  return grant.expires_at - 1
}

// grantedLine is one grant: "$12.40 left of $20.00, expires 4 Dec 2026".
export function grantedLine(grant: GrantedCredit): string {
  return `${usdMicro(grant.left_micro_usd)} left of ${usdMicro(grant.granted_micro_usd)}, expires ${formatDayShort(grantLastDay(grant))}`
}

// paidCredit is the credit that never expires: "$18.20 (never expires)".
export function paidCredit(w: Wallet): string | null {
  return w.paid_credit_micro_usd === undefined ? null : `${usdMicro(w.paid_credit_micro_usd)} (never expires)`
}
