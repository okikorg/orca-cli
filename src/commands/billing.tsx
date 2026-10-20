import type { Command } from 'commander'

import { openBrowser } from '../lib/browser.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatDate } from '../lib/format.js'
import { belowZeroNote, usdMicro } from '../lib/money.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { BillingURL } from '../lib/types.js'
import { hintText } from '../ui/theme.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// parseOffer maps what the user typed onto the checkout's offer: a plan
// (`pro`, `max`) or a credit pack by its price in cents (`pack:2000`, as
// `orca billing wallet` lists them).
export function parseOffer(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (value === 'pro' || value === 'max') return `plan:${value}`
  if (value === 'plan:pro' || value === 'plan:max') return value
  if (/^pack:\d+$/.test(value)) return value
  throw new CliError(`unknown offer "${raw}"`, ExitCode.Usage, [
    'Pass pro, max, or a credit pack as pack:<cents> (see: orca billing wallet).',
  ])
}

// handOff prints a Polar URL and, at a terminal, opens it. Scripts get the
// bare URL on stdout.
async function handOff(res: BillingURL, what: string, opts: { open: boolean }, json: boolean): Promise<void> {
  if (json) {
    printJson(res)
    return
  }
  if (!process.stdout.isTTY) {
    process.stdout.write(res.url + '\n')
    return
  }
  console.log(`${what}: ${res.url}`)
  if (opts.open && interactive()) {
    openBrowser(res.url)
    console.error(hintText('Opened it in your browser.'))
  }
}

export function registerBilling(program: Command): void {
  const billing = program
    .command('billing')
    .description('the credit wallet, buying credit or a plan, and managing the subscription')

  billing
    .command('wallet')
    .description('show the balance, plan, period, and the credit packs on sale')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const wallet = await withApi(api, (c) => c.wallet())
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(wallet)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['balance', usdMicro(wallet.balance_micro_usd)],
          ['credited', usdMicro(wallet.credited_micro_usd)],
          ['charged', usdMicro(wallet.charged_micro_usd)],
          ['min_balance', usdMicro(wallet.min_balance_micro_usd)],
          ['paid_work_paused', String(wallet.paid_work_paused)],
          ['tier', wallet.tier],
          ['period_start', formatDate(wallet.period_start)],
          ['period_end', formatDate(wallet.period_end)],
          ['used_compute_seconds', wallet.used_compute_seconds],
          ['included_compute_seconds', wallet.included_compute_seconds],
          ['packs', wallet.packs.map((p) => `pack:${p.cents}`).join(',') || '-'],
          ['openrouter_fee_bps', wallet.openrouter_fee_bps],
        ])
        // The rows stay key and value for cut and grep; the note goes to
        // stderr, as the CLI's other hints do.
        const note = belowZeroNote(wallet.balance_micro_usd, wallet.min_balance_micro_usd)
        if (note) console.error(hintText(note))
        return
      }
      const { WalletView } = await import('../ui/WalletView.js')
      await renderStatic(<WalletView wallet={wallet} />)
    })

  billing
    .command('buy <offer>')
    .description('open a checkout for a plan (pro, max) or a credit pack (pack:<cents>) (admin)')
    .option('--no-open', 'print the checkout link without opening a browser')
    .action(async (offerArg: string, opts: { open: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const offer = parseOffer(offerArg)
      const api = await apiContext(cmd)
      const res = await withApi(api, (c) => c.checkout(offer))
      await handOff(res, 'Checkout', opts, Boolean(flags.json))
    })

  billing
    .command('manage')
    .description('open the billing portal: change or cancel the plan, payment methods (admin)')
    .option('--no-open', 'print the portal link without opening a browser')
    .action(async (opts: { open: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const res = await withApi(api, (c) => c.portal())
      await handOff(res, 'Billing portal', opts, Boolean(flags.json))
    })
}
