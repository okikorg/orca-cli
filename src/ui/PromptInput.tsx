import { Box, Text, render } from 'ink'
import TextInput from 'ink-text-input'
import { useState } from 'react'

import { CliError, ExitCode } from '../lib/errors.js'
import { glyphs, theme } from './theme.js'

type PromptProps = {
  label: string
  // Secondary text after the label, e.g. "(y/N)": muted, never the primary
  // accent used for the pointer and the label itself.
  hint?: string
  placeholder?: string
  initial?: string
  mask?: boolean
  onSubmit: (value: string) => void
}

function Prompt({ label, hint, placeholder, initial, mask, onSubmit }: PromptProps) {
  const [value, setValue] = useState(initial ?? '')
  return (
    <Box>
      <Text color={theme.accent}>{glyphs.pointer} </Text>
      <Text>{label} </Text>
      {hint ? <Text color={theme.subtle}>{hint} </Text> : null}
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        placeholder={placeholder}
        mask={mask ? '*' : undefined}
      />
    </Box>
  )
}

// promptText mounts a one-line Ink prompt and resolves with the submitted
// value. On Ctrl-C, Ink unmounts without calling onSubmit; we detect that via
// waitUntilExit and reject with an interrupt so the process exits 130 rather
// than silently falling through to 0. Callers must check interactive() first.
export async function promptText(opts: {
  label: string
  hint?: string
  placeholder?: string
  initial?: string
  mask?: boolean
}): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`cannot prompt for "${opts.label}" without a terminal`)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const instance = render(
      <Prompt
        {...opts}
        onSubmit={(value) => {
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
