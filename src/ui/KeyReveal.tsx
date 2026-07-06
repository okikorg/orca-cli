import { Box, Text } from 'ink'

import { Panel } from './Panel.js'
import { theme } from './theme.js'

// One-time plaintext key display. The server stores only a hash; once this
// unmounts the token is unrecoverable, so say that plainly. Reuses the same
// coral-titled Panel frame as every other rich view.
export function KeyReveal({ token, label }: { token: string; label?: string }) {
  return (
    <Panel title={label ?? 'API key'}>
      <Text color={theme.accentStrong} bold>
        {token}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.subtle}>Shown once. Store it now; it cannot be retrieved again.</Text>
      </Box>
    </Panel>
  )
}
