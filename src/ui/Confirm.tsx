import { Box, Text, useInput } from 'ink'

import { glyphs, theme } from './theme.js'

type ConfirmProps = {
  message: string
  onDecision: (confirmed: boolean) => void
}

// Shared y/N confirm for destructive ops (delete/revoke/unpublish/cancel/rm):
// coral pointer + message + subtle `(y/N)`. Only `y`/`Y` confirms; anything
// else — including Enter — declines, so the safe answer is the default. The
// `--yes` bypass and non-TTY semantics live in the callers and stay unchanged;
// this component is mounted only in interactive TTY mode.
export function Confirm({ message, onDecision }: ConfirmProps) {
  useInput((input, key) => {
    if (key.return) {
      onDecision(false)
      return
    }
    onDecision(input.toLowerCase() === 'y')
  })

  return (
    <Box>
      <Text color={theme.accent}>{glyphs.pointer} </Text>
      <Text>{message} </Text>
      <Text color={theme.subtle}>(y/N)</Text>
    </Box>
  )
}
