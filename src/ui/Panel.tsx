import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

import { theme } from './theme.js'

// A single-line bordered frame with a coral title, the primary container for
// every rich view. Faithful to the design language: flat, border-delineated,
// one coral accent (the title). No rounded or double borders.
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
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
      {title ? (
        <Box marginBottom={1}>
          <Text color={theme.accent} bold>
            {title}
          </Text>
          {subtitle ? <Text color={theme.subtle}>{'  ' + subtitle}</Text> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  )
}

// A dim label / value pair line for detail views.
export function Field({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <Box>
      <Box width={12}>
        <Text color={theme.subtle}>{label}</Text>
      </Box>
      <Text color={valueColor}>{value}</Text>
    </Box>
  )
}
