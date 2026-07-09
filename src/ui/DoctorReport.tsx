import { Box, Text } from 'ink'

import type { CheckResult, CheckStatus } from '../lib/doctor.js'
import { glyphs, theme } from './theme.js'

// statusCell maps a check status to its themed glyph + one-word cell, per the
// design language: pass reads coral "ok" (the one accent), warn muted, fail
// destructive, skip subtle. Filled dot for pass/warn/fail, open dot for skip;
// both come from the glyphs map (never hardcoded) so the ASCII tier swaps them.
export function statusCell(status: CheckStatus): {
  label: string
  color: string
  glyph: string
} {
  switch (status) {
    case 'pass':
      return { label: 'ok', color: theme.accent, glyph: glyphs.statusFilled }
    case 'warn':
      return { label: 'warn', color: theme.muted, glyph: glyphs.statusFilled }
    case 'fail':
      return { label: 'fail', color: theme.destructive, glyph: glyphs.statusFilled }
    case 'skip':
      return { label: 'skip', color: theme.subtle, glyph: glyphs.statusOpen }
  }
}

// The status word column is padded to the widest label ("skip"/"warn"/"fail"
// are 4, "ok" is 2) so the name column aligns regardless of verdict.
const WORD_WIDTH = 4
const NAME_WIDTH = 20

// DoctorReport renders the preflight results borderless, per the design grammar:
// a bold coral header line (Doctor · host · N checks), one indented row per
// check (colored glyph + word, padded name, muted message), a subtle "fix:"
// line under any row that carries a remedy, then a footer summary counting
// ok / warn / fail colored per severity with subtle separators. Machine paths
// (--json, plain TSV) never reach this component.
export function DoctorReport({ results, host }: { results: CheckResult[]; host: string }) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const r of results) counts[r.status] += 1

  return (
    <Box flexDirection="column">
      {/* Header line: bold coral title, subtle ` · `-separated metadata. */}
      <Box marginBottom={1}>
        <Text color={theme.accent} bold>
          Doctor
        </Text>
        <Text color={theme.subtle}>{` ${glyphs.separator} ${host} ${glyphs.separator} ${results.length} checks`}</Text>
      </Box>

      {results.map((r) => {
        const cell = statusCell(r.status)
        return (
          <Box key={r.name} flexDirection="column">
            <Box>
              {/* Two-space content indent. */}
              <Text> </Text>
              <Box width={WORD_WIDTH + 2}>
                <Text color={cell.color}>{`${cell.glyph} ${cell.label}`}</Text>
              </Box>
              <Box width={NAME_WIDTH}>
                <Text bold>{r.name}</Text>
              </Box>
              <Text color={theme.muted}>{r.message}</Text>
            </Box>
            {r.fix ? (
              <Box>
                {/* Indent the fix line under the name column. */}
                <Box width={2 + WORD_WIDTH + 2 + NAME_WIDTH}>
                  <Text> </Text>
                </Box>
                <Text color={theme.subtle}>{`fix: ${r.fix}`}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}

      {/* Footer summary: N ok · N warn · N fail, each colored per severity. */}
      <Box marginTop={1}>
        <Text> </Text>
        <Text color={theme.accent}>{`${counts.pass} ok`}</Text>
        <Text color={theme.subtle}>{` ${glyphs.separator} `}</Text>
        <Text color={theme.muted}>{`${counts.warn} warn`}</Text>
        <Text color={theme.subtle}>{` ${glyphs.separator} `}</Text>
        <Text color={theme.destructive}>{`${counts.fail} fail`}</Text>
      </Box>
    </Box>
  )
}
