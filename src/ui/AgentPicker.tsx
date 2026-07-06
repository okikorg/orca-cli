import { Box, Text, render } from 'ink'
import SelectInput from 'ink-select-input'

import { CliError, ExitCode } from '../lib/errors.js'
import { POINTER, theme } from './theme.js'

type Item = { label: string; value: string }

// Selection state per the design language: coral pointer plus coral text,
// never an accent bar or inverted block.
function Indicator({ isSelected }: { isSelected?: boolean }) {
  return <Text color={theme.accent}>{isSelected ? `${POINTER} ` : '  '}</Text>
}

function Label({ isSelected, label }: { isSelected?: boolean; label: string }) {
  return <Text color={isSelected ? theme.accent : undefined}>{label}</Text>
}

function Picker({ title, items, onPick }: { title: string; items: Item[]; onPick: (v: string) => void }) {
  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        {title}
      </Text>
      <SelectInput
        items={items}
        indicatorComponent={Indicator}
        itemComponent={Label}
        onSelect={(item) => onPick((item as Item).value)}
      />
      <Text color={theme.subtle}>enter to select, ctrl+c to cancel</Text>
    </Box>
  )
}

// pickOne mounts an interactive list picker and resolves with the chosen
// value. On Ctrl-C it rejects with an interrupt (see promptText for the same
// pattern). Callers must check interactive() first.
export async function pickOne(title: string, values: string[]): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`cannot prompt for "${title}" without a terminal`)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const instance = render(
      <Picker
        title={title}
        items={values.map((v) => ({ label: v, value: v }))}
        onPick={(value) => {
          if (settled) return
          settled = true
          instance.unmount()
          resolve(value)
        }}
      />,
      { exitOnCtrlC: true },
    )
    void instance.waitUntilExit().then(() => {
      if (settled) return
      settled = true
      reject(new CliError('cancelled', ExitCode.Interrupt))
    })
  })
}
