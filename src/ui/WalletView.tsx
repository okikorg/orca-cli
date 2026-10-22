import { Box, Text } from 'ink'

import { formatDate } from '../lib/format.js'
import { belowZeroNote, tokenPrice, usdCents, usdMicro } from '../lib/money.js'
import type { Wallet } from '../lib/types.js'
import { creditRequest, freeModelCalls, grantedLine, machineTime, networkLine, paidCredit, WITHHELD } from '../lib/wallet.js'
import { Field, Panel } from './Panel.js'
import { theme } from './theme.js'

// The label column, wide enough for "granted credit" and a gap.
const LABEL_WIDTH = 16

// WalletView is `orca billing wallet` at a terminal: the balance as it is
// (negative after a late charge), the server's paused verdict, granted and
// paid credit, the Free plan's lines (free-plan D3.16) where the server
// sends them, and, below zero, the one line that says when paid work
// resumes.
export function WalletView({ wallet: w }: { wallet: Wallet }) {
  const note = belowZeroNote(w.balance_micro_usd, w.min_balance_micro_usd)
  const paid = paidCredit(w)
  const freeModel = freeModelCalls(w)
  const network = networkLine(w)
  const moreCredit = creditRequest(w)
  return (
    <Panel title="WALLET" subtitle={`${w.tier} plan`}>
      <Field
        width={LABEL_WIDTH}
        label="balance"
        value={usdMicro(w.balance_micro_usd)}
        valueColor={w.paid_work_paused ? theme.destructive : theme.accent}
      />
      <Field
        width={LABEL_WIDTH}
        label="paid work"
        value={w.paid_work_paused ? `paused under the ${usdMicro(w.min_balance_micro_usd)} minimum, until a top-up` : 'running'}
      />
      {(w.granted_credit ?? []).map((grant, i) => (
        <Field key={`grant-${i}`} width={LABEL_WIDTH} label="granted credit" value={grantedLine(grant)} />
      ))}
      {paid ? <Field width={LABEL_WIDTH} label="paid credit" value={paid} /> : null}
      <Field width={LABEL_WIDTH} label="credited" value={usdMicro(w.credited_micro_usd)} />
      <Field width={LABEL_WIDTH} label="charged" value={usdMicro(w.charged_micro_usd)} />
      <Field width={LABEL_WIDTH} label="period" value={`${formatDate(w.period_start)} to ${formatDate(w.period_end)}`} />
      <Field width={LABEL_WIDTH} label="machine time" value={machineTime(w)} />
      {w.included_hours_withheld ? <Text>{WITHHELD}</Text> : null}
      {freeModel ? <Field width={LABEL_WIDTH} label="free model" value={freeModel} /> : null}
      {network ? <Field width={LABEL_WIDTH} label="network" value={network} /> : null}
      <Field width={LABEL_WIDTH} label="tokens" value={`on Orca credit, ${tokenPrice(w.openrouter_fee_bps)}`} />
      {w.packs.length > 0 ? (
        <Field
          width={LABEL_WIDTH}
          label="packs"
          value={w.packs.map((p) => `pack:${p.cents} (${usdCents(p.cents)}, credits ${usdMicro(p.credited_micro_usd)})`).join(', ')}
        />
      ) : null}
      {moreCredit ? <Field width={LABEL_WIDTH} label="more credit" value={moreCredit} /> : null}
      {note ? (
        <Box marginTop={1}>
          <Text color={theme.destructive}>{note}</Text>
        </Box>
      ) : null}
    </Panel>
  )
}
