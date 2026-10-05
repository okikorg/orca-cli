import type { Command } from 'commander'

import { renderChart } from '../lib/chart.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatCount, formatDate, formatTime } from '../lib/format.js'
import { usdMicro } from '../lib/money.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { UsageDay, UsageEvent, UsageGroup, UsageMeter } from '../lib/types.js'
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

// dailySeries lays one meter's daily quantities over every day of the window,
// so days without usage plot as zero instead of vanishing from the axis.
export function dailySeries(daily: UsageDay[], meter: string, start: number, end: number): number[] {
  const byDate = new Map(daily.filter((d) => d.meter === meter).map((d) => [d.date, d.quantity]))
  const series: number[] = []
  for (let t = start - (start % DAY); t < end; t += DAY) series.push(byDate.get(formatDate(t)) ?? 0)
  return series
}

function groupKey(g: UsageGroup): string {
  return g.key ?? '(none)'
}

type SummaryOpts = { days: number; groupBy?: string; session?: string; meter: string }

export function registerUsage(program: Command): void {
  const usage = program
    .command('usage')
    .description('metered usage and what it cost, as the server prices it')

  usage
    .command('summary', { isDefault: true })
    .description('totals per meter over a window, a daily chart, and optional groups (the default)')
    .option('--days <n>', 'look-back window in days', (v) => parseInt(v, 10), 30)
    .option('--group-by <field>', `also total by ${GROUP_BY.join(' | ')}`)
    .option('--session <id>', 'only this session\'s usage')
    .option('--meter <name>', 'the meter the daily chart plots', 'model_tokens')
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
        // One row shape per invocation: the groups when asked for, else the
        // meter totals.
        if (opts.groupBy) {
          printPlainRows(
            (summary.groups ?? []).map((g) => [groupKey(g), g.meter, g.quantity, usdMicro(g.cost_micro_usd)]),
          )
        } else {
          printPlainRows(used.map((m) => [m.meter, m.quantity, m.unit, usdMicro(m.cost_micro_usd)]))
        }
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { Table } = await import('../ui/Table.js')
      const { Box, Text } = await import('ink')
      const { theme } = await import('../ui/theme.js')
      const chart = renderChart(dailySeries(summary.daily, opts.meter, summary.start, summary.end), {
        caption: `${opts.meter} per day, last ${opts.days} days`,
        empty: 'No usage in this window.',
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
                  { header: 'cost', get: (m: UsageMeter) => usdMicro(m.cost_micro_usd) },
                ]}
                rows={used}
              />
            </Box>
          ) : null}
          <Box marginTop={1} flexDirection="column">
            <Text>{chart}</Text>
          </Box>
          {summary.groups?.length ? (
            <Box marginTop={1} flexDirection="column">
              <Table
                title={`By ${opts.groupBy}`}
                headers
                columns={[
                  { header: opts.groupBy ?? 'key', get: groupKey, bold: true },
                  { header: 'meter', get: (g: UsageGroup) => g.meter },
                  { header: 'quantity', get: (g: UsageGroup) => formatCount(g.quantity) },
                  { header: 'cost', get: (g: UsageGroup) => usdMicro(g.cost_micro_usd) },
                ]}
                rows={summary.groups}
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
  addPageFlags(events)
  events.action(async (opts: PageFlags & { meter?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, (c) => c.usageEvents({ ...params, meter: opts.meter })),
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
    const what = (e: UsageEvent) => [e.provider, e.model, e.bucket].filter(Boolean).join(' ') || '-'
    if (mode === 'plain') {
      printPlainRows(
        page.items.map((e) => [
          formatTime(e.recorded_at),
          e.meter,
          e.quantity,
          what(e),
          usdMicro(e.cost_micro_usd),
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
          { header: 'detail', get: what },
          { header: 'cost', get: (e: UsageEvent) => usdMicro(e.cost_micro_usd) },
          { header: 'session', get: (e: UsageEvent) => e.session_id ?? '-' },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })
}
