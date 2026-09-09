import type { Command } from 'commander'

import { ApiError } from '../lib/api.js'
import { resetLabel, usd, usdFloat } from '../lib/money.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { hintText } from '../ui/theme.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// -- Wire shapes -------------------------------------------------------------
// Both mirror the conductor handlers the billing command already reads
// (billing.go and spendcap_settings.go). Kept structurally identical so the
// --json payload is the server's own, unreshaped.

type CreditPack = { cents: number; usd: number }

// GET /api/billing/wallet. `configured` is false when the tenant has never
// been granted credits (no Polar meter yet), so the balance stays 0 and
// rendering it would read as "you are broke" rather than "not applicable".
type CreditWallet = {
  configured: boolean
  balanceMicroUSD: number
  balanceUSD: number
  packs: CreditPack[]
}

type SpendCapPeriod = {
  limit_usd_cents: number
  limit_usd: number
  spent_usd_cents: number
  spent_usd: number
  remaining_usd_cents: number
  user_set: boolean
  resets_at: string
}

// GET /api/spend-cap. Only the monthly window matters here; the daily window
// is an ops runaway guard the tenant does not control.
type SpendCapResponse = {
  enabled: boolean
  month: SpendCapPeriod
  day: SpendCapPeriod
  billing_email: string
}

// isAuthError marks the failures that must never be degraded away. A bad or
// revoked key fails both endpoints identically, and quietly printing half a
// screen would hide the one thing the user needs to fix.
function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}

async function renderCredit(wallet?: CreditWallet, cap?: SpendCapResponse): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')

  const m = cap?.month
  // The wallet is prepaid credit; the cap is a monthly ceiling. Real spending
  // power is whichever runs out first, so both get the destructive colour on
  // their own terms.
  const balanceLow = wallet?.configured === true && wallet.balanceUSD <= 0
  const capSpent = m !== undefined && m.remaining_usd_cents <= 0 && m.spent_usd_cents > 0
  const reset = m ? resetLabel(m.resets_at) : ''

  const subtitle = wallet && wallet.configured === false ? 'no credits yet' : 'available to spend'

  await renderStatic(
    <Panel title="CREDIT" subtitle={subtitle}>
      {wallet?.configured ? (
        <Field
          label="balance"
          value={usdFloat(wallet.balanceUSD)}
          valueColor={balanceLow ? theme.destructive : theme.accent}
        />
      ) : null}
      {m ? <Field label="spent" value={usd(m.spent_usd_cents)} /> : null}
      {m ? (
        <Field
          label="cap left"
          value={usd(m.remaining_usd_cents)}
          valueColor={capSpent ? theme.destructive : theme.accent}
        />
      ) : null}
      {reset ? <Field label="resets" value={reset} /> : null}
      {wallet && wallet.packs.length > 0 ? (
        <Field label="top-up" value={wallet.packs.map((p) => usdFloat(p.usd)).join(', ')} />
      ) : null}
    </Panel>,
  )
}

export function registerCredit(program: Command): void {
  program
    .command('credit')
    .description('show the credit balance and what is left under the monthly spend cap')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)

      // One round trip each, concurrently. allSettled rather than all so a
      // single degraded endpoint still yields the half we did get.
      const [walletRes, capRes] = await Promise.allSettled([
        api.client.request<CreditWallet>('/api/billing/wallet'),
        api.client.request<SpendCapResponse>('/api/spend-cap'),
      ])

      const walletErr = walletRes.status === 'rejected' ? walletRes.reason : undefined
      const capErr = capRes.status === 'rejected' ? capRes.reason : undefined

      // An auth failure, or losing both endpoints, is a real error: surface it
      // through withApi so the exit-code contract applies.
      const fatal = [walletErr, capErr].find(isAuthError) ?? (walletErr && capErr ? walletErr : undefined)
      if (fatal !== undefined) {
        await withApi(api, () => Promise.reject(fatal))
      }

      const wallet = walletRes.status === 'fulfilled' ? walletRes.value : undefined
      const cap = capRes.status === 'fulfilled' ? capRes.value : undefined

      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson({ wallet: wallet ?? null, cap: cap ?? null })
        return
      }

      // Name what is missing on stderr so stdout stays machine-clean and the
      // partial view is never mistaken for the whole picture.
      if (walletErr) console.error(hintText('credit balance unavailable; showing the spend cap only.'))
      if (capErr) console.error(hintText('spend cap unavailable; showing the credit balance only.'))

      if (mode === 'plain') {
        const rows: (string | number)[][] = []
        if (wallet?.configured) {
          rows.push(['balanceUSD', wallet.balanceUSD.toFixed(2)])
          rows.push(['balanceMicroUSD', String(wallet.balanceMicroUSD)])
        } else if (wallet) {
          rows.push(['configured', 'false'])
        }
        if (cap) {
          rows.push(['spent_usd_cents', cap.month.spent_usd_cents])
          rows.push(['cap_remaining_usd_cents', cap.month.remaining_usd_cents])
          rows.push(['resets_at', cap.month.resets_at])
        }
        if (wallet) rows.push(['packs', wallet.packs.map((p) => p.cents).join(',') || '-'])
        printPlainRows(rows)
        return
      }

      await renderCredit(wallet, cap)
    })
}
