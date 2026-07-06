import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderStatic,
} from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// -- Wire shapes (mirrors dashboard/src/lib/types.ts + the conductor's
//    spendcap_settings.go / billing.go handlers) -----------------------------

// One purchasable credit top-up. Read-only; the checkout flow that spends it
// is intentionally out of scope for the CLI.
type CreditPack = { cents: number; usd: number }

// GET /api/billing/wallet. `configured` is false when the tenant has never
// been granted credits (no Polar meter yet), so the balance stays 0.
type CreditWallet = {
  configured: boolean
  balanceMicroUSD: number
  balanceUSD: number
  packs: CreditPack[]
}

// One budget window (day or month). Cents are authoritative; the _usd floats
// are display convenience. `user_set` says the tenant chose the limit (vs the
// system default), `resets_at` is the RFC3339 window rollover.
type SpendCapPeriod = {
  limit_usd_cents: number
  limit_usd: number
  spent_usd_cents: number
  spent_usd: number
  remaining_usd_cents: number
  user_set: boolean
  resets_at: string
}

// GET/PUT /api/spend-cap. Only the monthly window is self-serve; the daily
// window is an ops runaway guard and is not settable here.
type SpendCapResponse = {
  enabled: boolean
  month: SpendCapPeriod
  day: SpendCapPeriod
  billing_email: string
}

// usd formats a cents integer as a dollars-and-cents string. Cents are the
// authoritative unit server-side; we only ever render dollars for display.
function usd(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

// usdFloat formats an already-dollar float (e.g. wallet balanceUSD) with cents
// precision.
function usdFloat(dollars: number): string {
  const sign = dollars < 0 ? '-' : ''
  return `${sign}$${Math.abs(dollars).toFixed(2)}`
}

// resetLabel compacts an RFC3339 reset time to a short calendar day, matching
// the dashboard SpendCapCard. Returns '' for an unparseable value.
function resetLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

// Sentinels that clear the tenant's monthly override and revert to the system
// default (PUT with monthly_cap_usd_cents: null).
const CLEAR_SENTINELS = /^(default|none|clear)$/i

// parseDollarsToCents turns a user-typed dollar amount into an integer cents
// value, tolerating a leading "$" and thousands separators. Anything that is
// not a non-negative amount with at most two decimal places is a usage error
// (exit 2) - including negatives, which never reach here as a positive match.
function parseDollarsToCents(raw: string): number {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new CliError(`invalid amount "${raw}"`, ExitCode.Usage, [
      'Pass dollars like 10, 10.5, 10.50, or $10 (max two decimal places).',
      'Pass "default" to clear the cap and revert to the system default.',
    ])
  }
  const cents = Math.round(Number(cleaned) * 100)
  if (!Number.isFinite(cents) || cents < 0) {
    throw new CliError(`invalid amount "${raw}"`, ExitCode.Usage)
  }
  return cents
}

async function renderWallet(w: CreditWallet): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  const low = w.configured && w.balanceUSD <= 0
  await renderStatic(
    <Panel title="WALLET" subtitle={w.configured ? 'credit balance' : 'no credits yet'}>
      <Field
        label="balance"
        value={usdFloat(w.balanceUSD)}
        valueColor={low ? theme.destructive : theme.accent}
      />
      {w.packs.length > 0 ? (
        <Field label="top-up packs" value={w.packs.map((p) => usdFloat(p.usd)).join(', ')} />
      ) : null}
    </Panel>,
  )
}

async function renderCap(c: SpendCapResponse): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  const m = c.month
  const over = m.remaining_usd_cents <= 0 && m.spent_usd_cents > 0
  const reset = resetLabel(m.resets_at)
  await renderStatic(
    <Panel title="SPEND CAP" subtitle={m.user_set ? 'custom monthly limit' : 'system default'}>
      <Field label="monthly cap" value={usd(m.limit_usd_cents)} />
      <Field
        label="spent"
        value={usd(m.spent_usd_cents)}
        valueColor={over ? theme.destructive : undefined}
      />
      <Field
        label="remaining"
        value={usd(m.remaining_usd_cents)}
        valueColor={over ? theme.destructive : theme.accent}
      />
      {reset ? <Field label="resets" value={reset} /> : null}
      {c.billing_email ? <Field label="billing email" value={c.billing_email} /> : null}
    </Panel>,
  )
}

export function registerBilling(program: Command): void {
  const billing = program
    .command('billing')
    .description('view the credit wallet and set the monthly spend cap')

  // -- wallet -----------------------------------------------------------------
  billing
    .command('wallet')
    .description('show the tenant credit balance (read-only)')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const wallet = await withApi(api, (c) => c.request<CreditWallet>('/api/billing/wallet'))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(wallet)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['configured', String(wallet.configured)],
          ['balanceUSD', wallet.balanceUSD.toFixed(2)],
          ['balanceMicroUSD', String(wallet.balanceMicroUSD)],
          ['packs', wallet.packs.map((p) => p.cents).join(',') || '-'],
        ])
        return
      }
      await renderWallet(wallet)
    })

  // -- cap (show) -------------------------------------------------------------
  const cap = billing
    .command('cap')
    .description('show the monthly spend cap and accrued spend')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const res = await withApi(api, (c) => c.request<SpendCapResponse>('/api/spend-cap'))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(res)
        return
      }
      const m = res.month
      if (mode === 'plain') {
        printPlainRows([
          ['limit_usd_cents', m.limit_usd_cents],
          ['spent_usd_cents', m.spent_usd_cents],
          ['remaining_usd_cents', m.remaining_usd_cents],
          ['user_set', String(m.user_set)],
          ['resets_at', m.resets_at],
          ['billing_email', res.billing_email || '-'],
        ])
        return
      }
      await renderCap(res)
    })

  // -- cap set ----------------------------------------------------------------
  cap
    .command('set <amount>')
    .description('set the monthly cap in dollars (or "default" to clear the override)')
    .option('--email <address>', 'also set the billing email')
    .option('--yes', 'skip the confirmation prompt')
    .action(
      async (amount: string, opts: { email?: string; yes?: boolean }, cmd: Command) => {
        const flags = globalFlags(cmd)
        // Parse/validate BEFORE any network or prompt so garbage exits 2
        // cleanly with no side effects.
        const clearing = CLEAR_SENTINELS.test(amount.trim())
        const cents = clearing ? null : parseDollarsToCents(amount)

        const api = await apiContext(cmd)

        // Read the current cap so we can (a) warn when the new monthly cap is
        // below spend already accrued this month - the platform gates run
        // creation on the cap fail-closed, so this would immediately block
        // runs - and (b) skip a no-op write. A failed read (e.g. 503) must
        // not block the set; degrade silently.
        let current: SpendCapResponse | undefined
        try {
          current = await api.client.request<SpendCapResponse>('/api/spend-cap')
        } catch {
          current = undefined
        }
        if (!clearing && cents !== null && current && cents < current.month.spent_usd_cents) {
          const reset = resetLabel(current.month.resets_at)
          console.error(
            hintText(
              `warning: ${usd(cents)} is below this month's spend of ${usd(
                current.month.spent_usd_cents,
              )}; new runs will be blocked until the cap resets${reset ? ` (${reset})` : ''}.`,
            ),
          )
        }

        if (!opts.yes) {
          if (!interactive()) {
            throw new CliError(
              'refusing to change the spend cap without --yes in non-interactive mode',
              ExitCode.Usage,
            )
          }
          const question = clearing
            ? 'Clear the monthly spend cap and revert to the system default?'
            : `Set the monthly spend cap to ${usd(cents ?? 0)}?`
          if (!(await confirm(question))) {
            console.error(hintText('Aborted.'))
            return
          }
        }

        const body: { monthly_cap_usd_cents: number | null; billing_email?: string } = {
          monthly_cap_usd_cents: clearing ? null : cents,
          ...(opts.email !== undefined ? { billing_email: opts.email } : {}),
        }
        const updated = await withApi(api, (c) =>
          c.request<SpendCapResponse>('/api/spend-cap', {
            method: 'PUT',
            body: JSON.stringify(body),
          }),
        )
        if (outputMode(flags) === 'json') {
          printJson(updated)
          return
        }
        if (clearing) {
          console.log(`${accentVerb('Cleared')} the monthly spend cap (reverted to system default).`)
        } else {
          console.log(`${accentVerb('Set')} the monthly spend cap to ${usd(cents ?? 0)}.`)
        }
      },
    )
}
