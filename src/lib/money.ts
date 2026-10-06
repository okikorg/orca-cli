// Money formatting. The server sends every figure in micro-USD (or cents for
// a pack's price) and does all the arithmetic; the CLI only renders them.

// usdMicro formats a micro-USD figure as dollars. Two decimals for amounts of
// a cent or more; small charges keep four so a $0.0004 call does not read as
// $0.00, and a charge under $0.0001 reads as such rather than as zero.
export function usdMicro(micro: number): string {
  const sign = micro < 0 ? '-' : ''
  const dollars = Math.abs(micro) / 1_000_000
  if (dollars === 0) return '$0.00'
  if (dollars < 0.0001) return `${sign}<$0.0001`
  return `${sign}$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`
}

// usdCents formats an integer cents figure (a pack's price) as dollars.
export function usdCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}
