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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// formatDayMonth renders unix seconds as the UTC day and month, "1 November":
// the day a plan's period resets.
export function formatDayMonth(seconds: number): string {
  const d = new Date(seconds * 1000)
  if (Number.isNaN(d.getTime())) return '-'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

// formatDayShort renders unix seconds as the UTC day, short month and year,
// "4 Dec 2026".
export function formatDayShort(seconds: number): string {
  const d = new Date(seconds * 1000)
  if (Number.isNaN(d.getTime())) return '-'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`
}

// formatHours renders seconds as hours to a tenth, rounded down so time not
// all used never reads as all used: 3600 is "1 h", 1440 "0.4 h", 3,600,000
// "1,000 h".
export function formatHours(seconds: number): string {
  const tenths = Math.floor(Math.max(0, seconds) / 360)
  const whole = String(Math.floor(tenths / 10)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return tenths % 10 ? `${whole}.${tenths % 10} h` : `${whole} h`
}
