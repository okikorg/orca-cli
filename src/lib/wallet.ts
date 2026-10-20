// The wallet's Free plan and granted credit lines (orca-design free-plan
// D3.16, "What a person sees", CLI), shared by the panel at a terminal and
// the plain rows. Every figure and message is the server's; the CLI only
// formats them.

import { formatDayMonth, formatDayShort, formatHours } from './format.js'
import { stripControlSequences } from './markdown.js'
import { usdMicro } from './money.js'
import type { GrantedCredit, Wallet } from './types.js'

// machineTime is the period's included machine time and how much is used:
// "1 h included: 0.4 h used, resets 1 November", or "used" once it all is.
export function machineTime(w: Wallet): string {
  const used = w.used_compute_seconds >= w.included_compute_seconds ? 'used' : `${formatHours(w.used_compute_seconds)} used`
  return `${formatHours(w.included_compute_seconds)} included: ${used}, resets ${formatDayMonth(w.period_end)}`
}

// freeModelCalls is the free model's calls today against the share, on Free:
// "40 of 100 calls today". Null on Pro and Max.
export function freeModelCalls(w: Wallet): string | null {
  return w.free_model ? `${w.free_model.calls_today} of ${w.free_model.calls_per_day} calls today` : null
}

// networkOff is the network line while Free sandboxes have none: "off."
// and the server's message. Null when the network is on.
export function networkOff(w: Wallet): string | null {
  return w.network?.off ? `off. ${stripControlSequences(w.network.message ?? '')}`.trimEnd() : null
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
