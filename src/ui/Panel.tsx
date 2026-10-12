import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

import { glyphs, theme } from './theme.js'

// A borderless Section: a bold mint header line (title, then subtle ` · `
// metadata from `subtitle`), with children indented two spaces. No frame.
// Hierarchy is whitespace and weight, not boxes. The name stays `Panel` and the
// prop stays `subtitle` so every existing detail/list call site compiles
// unchanged; `subtitle` now reads as the header's ` · `-separated meta.
export function Panel({
  title,
  subtitle,
  children,
}: {
  title?: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <Box flexDirection="column">
      {title ? (
        <Box>
          <Text color={theme.accent} bold>
            {title}
          </Text>
          {subtitle ? <Text color={theme.subtle}>{` ${glyphs.separator} ${subtitle}`}</Text> : null}
        </Box>
      ) : null}
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  )
}

// A dim label / value pair line for detail views. The subtle label column is
// 12 wide unless a view passes `width`, and always leaves a space before the
// value: a longer label widens its own line instead of wrapping or touching
// the value. The two-space indent comes from the Section's padded body, so a
// Field used outside a Panel needs its own indent.
export function Field({
  label,
  value,
  valueColor,
  width = 12,
}: {
  label: string
  value: string
  valueColor?: string
  width?: number
}) {
  return (
    <Box>
      <Box width={Math.max(width, label.length + 1)} flexShrink={0}>
        <Text color={theme.subtle}>{label}</Text>
      </Box>
      <Text color={valueColor}>{value}</Text>
    </Box>
  )
}
