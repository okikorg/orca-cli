// Money formatting. The server sends every figure in micro-USD (or cents for
// a pack's price) and does all the arithmetic; the CLI only renders them.

// usdMicro formats a micro-USD figure as dollars by money-payments' display
// rule, in integer arithmetic, as the dashboard does: "$1,234.57" at a cent
// or more (rounded half up to the cent), every digit under a cent
// ("$0.000047") so a small charge never reads as free, "$0.00" for zero,
// and the sign first ("-$1.50").
export function usdMicro(micro: number): string {
  if (!Number.isFinite(micro)) return '$0.00'
  const sign = micro < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(micro))
  if (abs > 0 && abs < 10_000) return `${sign}$0.${String(abs).padStart(6, '0').replace(/0+$/, '')}`
  const cents = Math.floor((abs + 5_000) / 10_000)
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}$${whole}.${String(cents % 100).padStart(2, '0')}`
}

// usdCents formats a cents figure (a pack's price) as dollars by the same rule.
export function usdCents(cents: number): string {
  return usdMicro(cents * 10_000)
}
