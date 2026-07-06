import type { RunEvent, RunSummary, Usage } from './types.js'

// compactJson renders tool inputs/outputs on one line, truncated.
export function compactJson(v: unknown, max = 120): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  const flat = s.replace(/\s+/g, ' ')
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat
}

// formatEventText is the uncolored line for plain/non-TTY sinks; RunTail
// renders the same structure with theme colors.
export function formatEventText(e: RunEvent): string | null {
  switch (e.type) {
    case 'assistant':
      return e.message ?? ''
    case 'tool_call':
      return `tool ${e.toolName ?? '?'} ${compactJson(e.input)}`.trimEnd()
    case 'tool_result':
      return `  -> ${e.isError ? 'error ' : ''}${compactJson(e.output ?? e.message)}`.trimEnd()
    case 'progress':
      return e.message ?? null
    case 'error':
      return `error: ${e.message ?? 'unknown'}`
    case 'result':
      return e.message ?? null
    case 'usage':
      // Accumulated into totals, never a log line.
      return null
  }
}

export function addUsage(total: Usage, u?: Usage): Usage {
  if (!u) return total
  return {
    inputTokens: (total.inputTokens ?? 0) + (u.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (u.outputTokens ?? 0),
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
    cacheCreateTokens: (total.cacheCreateTokens ?? 0) + (u.cacheCreateTokens ?? 0),
  }
}

export function formatUsage(u: Usage): string {
  const parts: string[] = []
  if (u.inputTokens) parts.push(`in ${u.inputTokens}`)
  if (u.outputTokens) parts.push(`out ${u.outputTokens}`)
  if (u.cacheReadTokens) parts.push(`cache ${u.cacheReadTokens}`)
  return parts.join(' ')
}

// formatTimestamp compacts a run timestamp to "YYYY-MM-DD HH:MM". The
// conductor sometimes returns nanosecond precision with a trailing marker
// (e.g. "2026-07-05T09:57:32.354596652s"), so parse the leading fields
// directly rather than trusting Date.parse, and keep the wire time (no
// timezone shift).
export function formatTimestamp(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v)
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  return v.length > 16 ? v.slice(0, 16) : v
}

export function formatDuration(startISO: string, endISO?: string): string {
  const start = Date.parse(startISO)
  const end = endISO ? Date.parse(endISO) : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end)) return '-'
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m${secs % 60}s`
  return `${Math.floor(mins / 60)}h${mins % 60}m`
}

export function runRow(r: RunSummary): (string | undefined)[] {
  return [
    r.id,
    r.subTask.profile,
    r.status,
    formatTimestamp(r.startedAt),
    r.finishedAt ? formatDuration(r.startedAt, r.finishedAt) : '-',
  ]
}
