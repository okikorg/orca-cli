import type { Command } from 'commander'

import { renderChart } from '../lib/chart.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatCount, formatTime } from '../lib/format.js'
import { usdMicro } from '../lib/money.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { UsageEvent, UsageMeter } from '../lib/types.js'
import { eventCost, eventDetail, groupRows, usageChart, type GroupRow } from '../lib/usage.js'
import { hintText } from '../ui/theme.js'
import {
  addPageFlags,
  apiContext,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type PageFlags,
} from './shared.js'

const GROUP_BY = ['model', 'provider', 'credential', 'session', 'agent'] as const
const DAY = 86_400

function groupKey(g: GroupRow): string {
  return g.key ?? '(none)'
}

type SummaryOpts = { days: number; groupBy?: string; session?: string; meter: string }

export function registerUsage(program: Command): void {
  const usage = program
    .command('usage')
    .description('metered usage and what it cost, as the server prices it')

  usage
    .command('summary', { isDefault: true })
    .description('totals per meter over a window, a chart by the hour or the day, and optional groups (the default)')
    .option('--days <n>', 'look-back window in days (1 or 2 chart by the hour)', (v) => parseInt(v, 10), 30)
    .option('--group-by <field>', `also total by ${GROUP_BY.join(' | ')}`)
    .option('--session <id>', 'only this session\'s usage')
    .option('--meter <name>', 'the meter the chart plots', 'model_tokens')
    .action(async (opts: SummaryOpts, cmd: Command) => {
      const flags = globalFlags(cmd)
      if (!Number.isFinite(opts.days) || opts.days <= 0) {
        throw new CliError('--days must be a positive number', ExitCode.Usage)
      }
      if (opts.groupBy && !(GROUP_BY as readonly string[]).includes(opts.groupBy)) {
        throw new CliError(`--group-by must be one of: ${GROUP_BY.join(', ')}`, ExitCode.Usage)
      }
      const api = await apiContext(cmd)
      const end = Math.floor(Date.now() / 1000) + 1
      const start = end - opts.days * DAY
      const summary = await withApi(api, (c) =>
        c.usage({ start, end, group_by: opts.groupBy, session: opts.session }),
      )
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(summary)
        return
      }
      const used = summary.meters.filter((m) => m.quantity !== 0 || m.cost_micro_usd !== 0)
      if (mode === 'plain') {
        // One row shape per invocation: each key's tokens and cost when
        // grouped, else the meter totals.
        if (opts.groupBy) {
          printPlainRows(groupRows(summary).map((g) => [groupKey(g), g.tokens, usdMicro(g.cost)]))
        } else {
          if (used.length === 0) console.error(hintText('No usage in this window.'))
          printPlainRows(used.map((m) => [m.meter, m.quantity, m.unit, usdMicro(m.cost_micro_usd)]))
        }
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { Table } = await import('../ui/Table.js')
      const { Box, Text } = await import('ink')
      const { theme } = await import('../ui/theme.js')
      const plot = usageChart(summary, opts.meter, opts.days)
      const chart = renderChart(plot.values, {
        caption: plot.caption,
        empty: plot.empty,
        format: (v) => formatCount(Math.round(v)),
      })
      await renderStatic(
        <Panel title="Usage" subtitle={opts.session ? `session ${opts.session}` : `last ${opts.days} days`}>
          <Field label="cost" value={usdMicro(summary.cost_micro_usd)} valueColor={theme.accent} />
          {used.length ? (
            <Box marginTop={1} flexDirection="column">
              <Table
                headers
                columns={[
                  { header: 'meter', get: (m: UsageMeter) => m.meter, bold: true },
                  { header: 'quantity', get: (m: UsageMeter) => `${formatCount(m.quantity)} ${m.unit}` },
                  // A meter with no charge shows none: token rows are at cost
                  // 0 because their call's row carries the money.
                  { header: 'cost', get: (m: UsageMeter) => (m.cost_micro_usd ? usdMicro(m.cost_micro_usd) : '-') },
                ]}
                rows={used}
              />
            </Box>
          ) : null}
          <Box marginTop={1} flexDirection="column">
            <Text>{chart}</Text>
          </Box>
          {opts.groupBy && groupRows(summary).length ? (
            <Box marginTop={1} flexDirection="column">
              <Table
                title={`By ${opts.groupBy}`}
                headers
                columns={[
                  { header: opts.groupBy, get: groupKey, bold: true },
                  { header: 'tokens', get: (g: GroupRow) => (g.tokens ? formatCount(g.tokens) : '-') },
                  { header: 'cost', get: (g: GroupRow) => usdMicro(g.cost) },
                ]}
                rows={groupRows(summary)}
              />
            </Box>
          ) : null}
        </Panel>,
      )
    })

  const events = usage
    .command('events')
    .description('raw usage rows, newest first, each with its cost')
    .option('--meter <name>', 'only rows of this meter')
    .option('--charged', 'only the rows with a cost: the ones the wallet\'s charges sum')
  addPageFlags(events)
  events.action(async (opts: PageFlags & { meter?: string; charged?: boolean }, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, (c) => c.usageEvents({ ...params, meter: opts.meter, charged: opts.charged })),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No usage recorded yet.'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(
        page.items.map((e) => [
          formatTime(e.recorded_at),
          e.meter,
          e.quantity,
          eventDetail(e),
          eventCost(e),
          e.session_id ?? '-',
        ]),
      )
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Usage events"
        meta={pagedSubtitle(page)}
        headers
        columns={[
          { header: 'when', get: (e: UsageEvent) => formatTime(e.recorded_at), color: () => theme.subtle },
          { header: 'meter', get: (e: UsageEvent) => e.meter, bold: true },
          { header: 'quantity', get: (e: UsageEvent) => formatCount(e.quantity) },
          { header: 'detail', get: eventDetail },
          { header: 'cost', get: eventCost },
          { header: 'session', get: (e: UsageEvent) => e.session_id ?? '-' },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })
}
