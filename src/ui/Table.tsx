import { Box, Text } from 'ink'

import { theme } from './theme.js'

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
// each and truncate overlong cells so the bordered panel never wraps.
const MAX_COL = 40

function fit(text: string, width: number): string {
  const clipped = text.length > width ? text.slice(0, width - 3) + '...' : text
  return clipped.padEnd(width + 2)
}

// Column table with coral uppercase headers and a subtle rule beneath them.
// Cells use the terminal default unless a column supplies a color. Flat, no
// zebra, two-space gutters, matching the instrument aesthetic.
export function Table<T>({ columns, rows }: { columns: Column<T>[]; rows: T[] }) {
  const widths = columns.map((col) =>
    Math.min(MAX_COL, Math.max(col.header.length, ...rows.map((row) => col.get(row).length))),
  )
  return (
    <Box flexDirection="column">
      <Box>
        {columns.map((col, i) => (
          <Text key={col.header} color={theme.accent} bold>
            {fit(col.header.toUpperCase(), widths[i])}
          </Text>
        ))}
      </Box>
      <Box>
        {columns.map((col, i) => (
          <Text key={col.header} color={theme.border}>
            {'─'.repeat(widths[i]).padEnd(widths[i] + 2)}
          </Text>
        ))}
      </Box>
      {rows.map((row, r) => (
        <Box key={r}>
          {columns.map((col, i) => (
            <Text key={col.header} color={col.color?.(row)} bold={col.bold}>
              {fit(col.get(row), widths[i])}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
