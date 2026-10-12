import type { Command } from 'commander'

import { groupHeading, payerWord, priceLine, withPayer } from '../lib/models.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { PickModel } from '../lib/types.js'
import { hintText } from '../ui/theme.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// Model names wide enough to show whole, so a name can be copied from the
// table (orca/openrouter/<OpenRouter id> runs past the usual cap).
const MODEL_COLUMN = 80

// `orca models` lists every model a member can pick, grouped by who pays,
// from GET /api/models: the picker's list, outside a terminal too
// (orca-design publish-cli, D5.7, amended 2026-10-12). Every name and price
// is the server's.
export function registerModels(program: Command): void {
  program
    .command('models')
    .description('list the models you can use, grouped by who pays')
    .option('--payer <payer>', 'only the models one payer pays for: orca (Orca credit), or a provider whose key you saved')
    .action(async (opts: { payer?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const list = withPayer(await withApi(api, (c) => c.models()), opts.payer)
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(list)
        return
      }
      for (const group of list.groups.filter((g) => !g.available)) {
        console.error(hintText(`${group.label}: the server could not read this list.`))
      }
      if (mode === 'plain') {
        printPlainRows(
          list.groups.flatMap((group) => group.models.map((m) => [m.id, payerWord(group), priceLine(m) ?? '-'])),
        )
        return
      }
      const groups = list.groups.filter((g) => g.models.length > 0)
      if (groups.length === 0) {
        console.error(hintText('No models to list.'))
        return
      }
      const { Box } = await import('ink')
      const { Table } = await import('../ui/Table.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Box flexDirection="column" gap={1}>
          {groups.map((group, i) => (
            <Table
              key={`${group.payer}:${group.provider}`}
              title={groupHeading(group, list.openrouter_fee_bps)}
              meta={`--payer ${payerWord(group)}`}
              headers
              hint={i === groups.length - 1 ? 'put a name in an agent file\'s model: orca agents create -f agent.yaml' : undefined}
              columns={[
                { header: 'model', get: (m: PickModel) => m.id, color: () => theme.accent, bold: true, max: MODEL_COLUMN },
                ...(group.payer === 'orca_credit'
                  ? [{ header: 'openrouter price', get: (m: PickModel) => priceLine(m) ?? '-', max: MODEL_COLUMN }]
                  : []),
              ]}
              rows={group.models}
            />
          ))}
        </Box>,
      )
    })
}
