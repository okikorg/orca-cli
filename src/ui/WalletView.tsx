import { Box, Text } from 'ink'

import { formatDate } from '../lib/format.js'
import { belowZeroNote, tokenPrice, usdCents, usdMicro } from '../lib/money.js'
import type { Wallet } from '../lib/types.js'
import { Field, Panel } from './Panel.js'
import { theme } from './theme.js'

// WalletView is `orca billing wallet` at a terminal: the balance as it is
// (negative after a late charge), the server's paused verdict, and, below
// zero, the one line that says when paid work resumes.
export function WalletView({ wallet: w }: { wallet: Wallet }) {
  const note = belowZeroNote(w.balance_micro_usd, w.min_balance_micro_usd)
  return (
    <Panel title="WALLET" subtitle={`${w.tier} plan`}>
      <Field
        label="balance"
        value={usdMicro(w.balance_micro_usd)}
        valueColor={w.paid_work_paused ? theme.destructive : theme.accent}
      />
      <Field
        label="paid work"
        value={w.paid_work_paused ? `paused under the ${usdMicro(w.min_balance_micro_usd)} minimum, until a top-up` : 'running'}
      />
      <Field label="credited" value={usdMicro(w.credited_micro_usd)} />
      <Field label="charged" value={usdMicro(w.charged_micro_usd)} />
      <Field label="period" value={`${formatDate(w.period_start)} to ${formatDate(w.period_end)}`} />
      <Field label="compute" value={`${w.used_compute_seconds}s used of ${w.included_compute_seconds}s included`} />
      <Field label="tokens" value={`on Orca credit, ${tokenPrice(w.openrouter_fee_bps)}`} />
      {w.packs.length > 0 ? (
        <Field
          label="packs"
          value={w.packs.map((p) => `pack:${p.cents} (${usdCents(p.cents)}, credits ${usdMicro(p.credited_micro_usd)})`).join(', ')}
        />
      ) : null}
      {note ? (
        <Box marginTop={1}>
          <Text color={theme.destructive}>{note}</Text>
        </Box>
      ) : null}
    </Panel>
  )
}
