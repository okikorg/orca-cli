import { Box, Text } from 'ink'

import { glyphs, theme } from './theme.js'
import type { RunStatus } from '../lib/types.js'

export type Column<T> = {
  header: string
  get: (row: T) => string
  // Optional per-cell color (hex from theme); undefined leaves the
  // terminal's default foreground.
  color?: (row: T) => string | undefined
  // Render the cell bold (used for the primary/name column).
  bold?: boolean
}

// No single column is allowed to blow out the table past the terminal; cap
// each and truncate overlong cells so the row never wraps.
const MAX_COL = 40

function fit(text: string, width: number): string {
  const clipped = text.length > width ? text.slice(0, width - 3) + '...' : text
  return clipped.padEnd(width + 2)
}

// A status glyph + word as one string, for a Column<T>.get that renders a
// run's state (`● running`, `● error`). Pair with statusColor in the column's
// `color` fn so the whole cell takes the status color. The glyph comes from the
// active tier (Unicode `●` / ASCII `*`); never hardcode it at a call site.
export function statusDot(status: RunStatus): string {
  return `${glyphs.statusFilled} ${status}`
}

// Borderless column list. Hierarchy is whitespace and weight, not boxes.
// - Optional header line: bold coral `title`, then subtle ` · `-joined `meta`.
// - Optional `headers` row: a single subtle UPPERCASE label row (no coral, no
//   rule) — pass it for wide/ambiguous tables, omit for short ones.
// - Optional `hint`: a subtle `next: ...` footer teaching follow-up commands.
// Cells use the terminal default unless a column supplies a color. Two-space
// gutters, MAX_COL cap, truncation — all preserved. Callers that pass only
// `columns`/`rows` render a bare aligned grid exactly as before.
export function Table<T>({
  columns,
  rows,
  title,
  meta,
  hint,
  headers,
}: {
  columns: Column<T>[]
  rows: T[]
  // Header line: bold coral title.
  title?: string
  // Header-line metadata, joined with the separator glyph in subtle gray.
  meta?: string | string[]
  // Subtle `next: ...` footer line teaching follow-up commands.
  hint?: string
  // Show the subtle UPPERCASE column-label row.
  headers?: boolean
}) {
  const widths = columns.map((col) =>
    Math.min(
      MAX_COL,
      Math.max(headers ? col.header.length : 0, ...rows.map((row) => col.get(row).length)),
    ),
  )
  const metaParts = (Array.isArray(meta) ? meta : meta ? [meta] : []).filter((p) => p.length > 0)
  return (
    <Box flexDirection="column">
      {title ? (
        <Box>
          <Text color={theme.accent} bold>
            {title}
          </Text>
          {metaParts.length ? (
            <Text color={theme.subtle}>{` ${glyphs.separator} ${metaParts.join(` ${glyphs.separator} `)}`}</Text>
          ) : null}
        </Box>
      ) : null}
      {headers ? (
        <Box>
          {columns.map((col, i) => (
            <Text key={col.header} color={theme.subtle}>
              {fit(col.header.toUpperCase(), widths[i])}
            </Text>
          ))}
        </Box>
      ) : null}
      {rows.map((row, r) => (
        <Box key={r}>
          {columns.map((col, i) => (
            <Text key={col.header} color={col.color?.(row)} bold={col.bold}>
              {fit(col.get(row), widths[i])}
            </Text>
          ))}
        </Box>
      ))}
      {hint ? (
        <Box>
          <Text color={theme.subtle}>{`next: ${hint}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
