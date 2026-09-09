// Money formatting shared by the billing and credit commands. Cents (and
// micro-USD on the wallet) are the authoritative units server-side; dollars
// exist only for display, so every renderer goes through these.

// usd formats an integer cents value as a dollars-and-cents string.
export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

// usdFloat formats an already-dollar float (e.g. wallet balanceUSD) with cents
// precision.
export function usdFloat(dollars: number): string {
  const sign = dollars < 0 ? '-' : ''
  return `${sign}$${Math.abs(dollars).toFixed(2)}`
}

// resetLabel compacts an RFC3339 reset time to a short calendar day, matching
// the dashboard SpendCapCard. Returns '' for an unparseable value.
export function resetLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}
