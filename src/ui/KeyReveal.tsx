import { Box, Text } from 'ink'

import { theme } from './theme.js'

// One-time plaintext key display. The server stores only a hash; once this
// unmounts the token is unrecoverable, so say that plainly. Follows the
// borderless grammar: a bold coral header line, content indented two spaces,
// no frame. The token itself stays accentStrong+bold so it is easy to select.
export function KeyReveal({ token, label }: { token: string; label?: string }) {
  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        {label ?? 'API key'}
      </Text>
      <Box marginTop={1}>
        <Text> </Text>
        <Text color={theme.accentStrong} bold>
          {token}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text> </Text>
        <Text color={theme.subtle}>Shown once. Store it now; it cannot be retrieved again.</Text>
      </Box>
    </Box>
  )
}
