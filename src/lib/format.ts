// Shared display formatting for server timestamps, which are unix seconds.

// formatTime renders unix seconds as "YYYY-MM-DD HH:MM" in UTC, the same in
// every terminal and timezone so plain output stays stable for scripts.
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null) return '-'
  const d = new Date(seconds * 1000)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

// formatDate renders unix seconds as a UTC calendar day.
export function formatDate(seconds: number): string {
  const d = new Date(seconds * 1000)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toISOString().slice(0, 10)
}

// formatCount renders large counts as 1.2k / 3.4M.
export function formatCount(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
