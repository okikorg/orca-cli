import { Box, Text } from 'ink'

import type { CheckResult, CheckStatus } from '../lib/doctor.js'
import { Panel } from './Panel.js'
import { theme } from './theme.js'

// statusCell maps a check status to its themed one-word cell: pass reads coral
// "ok" (the one accent), warn muted, fail destructive, skip subtle. No accent
// bars, no emoji, single accent only.
export function statusCell(status: CheckStatus): { label: string; color: string } {
  switch (status) {
    case 'pass':
      return { label: 'ok', color: theme.accent }
    case 'warn':
      return { label: 'warn', color: theme.muted }
    case 'fail':
      return { label: 'fail', color: theme.destructive }
    case 'skip':
      return { label: 'skip', color: theme.subtle }
  }
}

// DoctorReport renders the preflight results as a coral-titled DOCTOR panel: one
// row per check (status cell, name, message) with a subtle "fix:" line beneath
// any warn/fail that carries a remedy.
export function DoctorReport({ results, subtitle }: { results: CheckResult[]; subtitle: string }) {
  return (
    <Panel title="DOCTOR" subtitle={subtitle}>
      {results.map((r) => {
        const cell = statusCell(r.status)
        return (
          <Box key={r.name} flexDirection="column">
            <Box>
              <Box width={6}>
                <Text color={cell.color}>{cell.label}</Text>
              </Box>
              <Box width={20}>
                <Text bold>{r.name}</Text>
              </Box>
              <Text color={theme.muted}>{r.message}</Text>
            </Box>
            {r.fix ? (
              <Box>
                <Box width={6}>
                  <Text> </Text>
                </Box>
                <Text color={theme.subtle}>{`fix: ${r.fix}`}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Panel>
  )
}
