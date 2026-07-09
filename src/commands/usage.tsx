import type { Command } from 'commander'

import { renderChart } from '../lib/chart.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTimestamp } from '../lib/format.js'
import { assertWindow } from '../lib/window.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// -- Wire shapes (subset of the conductor stats/usage DTOs) -------------------
// Anchored on GET /api/stats/timeseries (docs/openapi.sdk.yaml, Stats group;
// runtime/httpapi/stats.go statsBucketDTO) for the over-time series, plus the
// best-effort GET /api/usage meter surface (runtime/httpapi/usage.go, PR #169)
// for tool-call and sandbox-compute totals. Both are tenant-key accessible.

type Usage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
}

type StatsBucket = {
  start: string
  end: string
  runs: number
  failedRuns: number
  runningRuns: number
  tokens: Usage
  costCents: number
}

type StatsTimeseries = {
  window: string
  bucket: string
  since: string
  until: string
  buckets: StatsBucket[]
}

type UsageMeters = {
  window: string
  totals: { toolCalls: number; sandboxSeconds: number }
  byProfile: { profile: string; toolCalls: number; sandboxSeconds: number }[]
}

// Meters that carry per-bucket time series and so can be plotted. Tool-call and
// sandbox meters are aggregate-only (no buckets), so they are surfaced as
// summary fields, never as a fake flat line.
const PLOTTABLE = ['tokens', 'cost', 'runs'] as const
type PlotMeter = (typeof PLOTTABLE)[number]

function totalTokens(u: Usage): number {
  return (
    (u.inputTokens ?? 0) +
    (u.outputTokens ?? 0) +
    (u.cacheReadTokens ?? 0) +
    (u.cacheCreateTokens ?? 0)
  )
}

// seriesFor extracts the plottable value for the chosen meter from each bucket.
function seriesFor(buckets: StatsBucket[], meter: PlotMeter): number[] {
  switch (meter) {
    case 'tokens':
      return buckets.map((b) => totalTokens(b.tokens))
    case 'cost':
      return buckets.map((b) => b.costCents / 100)
    case 'runs':
      return buckets.map((b) => b.runs)
  }
}

// fmtCompact renders large counts as 1.2k / 3.4M, matching the dashboard Usage
// page's token formatting.
function fmtCompact(n: number): string {
  if (n === 0) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtUSD(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// cleanDuration trims Go's "15m0s" / "1h0m0s" duration strings to "15m" / "1h".
function cleanDuration(d: string): string {
  return d.replace(/(\d+[hm])0s$/u, '$1').replace(/(\d+h)0m$/u, '$1')
}

// resolveWindow maps the flags onto the conductor's window token. --window wins
// over --days; the default (7d) matches the dashboard Usage page.
function resolveWindow(opts: { window?: string; days?: number }): string {
  if (opts.window) return assertWindow(opts.window)
  if (opts.days != null) {
    if (!Number.isFinite(opts.days) || opts.days <= 0) {
      throw new CliError('--days must be a positive number', ExitCode.Usage)
    }
    return `${opts.days}d`
  }
  return '7d'
}

export function registerUsage(program: Command): void {
  program
    .command('usage')
    .description('token, cost, and run usage over time, with tool-call and sandbox meters')
    .option('--window <w>', 'look-back window: 1h, 24h, 7d, 30d (default 7d)')
    .option('--days <n>', 'look-back window in days (shorthand for --window Nd)', (v) => parseInt(v, 10))
    .option('--meter <kind>', `series to plot: ${PLOTTABLE.join(' | ')} (default tokens)`, 'tokens')
    .action(
      async (
        opts: { window?: string; days?: number; meter: string; },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const meter = opts.meter as PlotMeter
        if (!PLOTTABLE.includes(meter)) {
          throw new CliError(
            `--meter must be one of: ${PLOTTABLE.join(', ')}`,
            ExitCode.Usage,
            ['Tool-call and sandbox meters are aggregate-only and shown as totals, not plotted.'],
          )
        }
        const window = resolveWindow(opts)
        const api = await apiContext(cmd)

        const ts = await withApi(api, (c) =>
          c.request<StatsTimeseries>(`/api/stats/timeseries?window=${encodeURIComponent(window)}`),
        )
        // Meter totals are additive: the endpoint may be absent (older
        // conductor) or empty. Degrade to null rather than failing the view.
        let meters: UsageMeters | null = null
        try {
          meters = await api.client.request<UsageMeters>(
            `/api/usage?window=${encodeURIComponent(window)}`,
          )
        } catch {
          meters = null
        }

        const buckets = ts.buckets ?? []
        const series = seriesFor(buckets, meter)
        const totTokens = buckets.reduce((s, b) => s + totalTokens(b.tokens), 0)
        const totRuns = buckets.reduce((s, b) => s + b.runs, 0)
        const totFailed = buckets.reduce((s, b) => s + b.failedRuns, 0)
        const totCents = buckets.reduce((s, b) => s + b.costCents, 0)

        const mode = outputMode(flags)

        if (mode === 'json') {
          printJson({ window, meter, timeseries: ts, meters })
          return
        }

        if (mode === 'plain') {
          // One tab-separated row per bucket: date, meter kind, quantity, cost.
          printPlainRows(
            buckets.map((b, i) => [
              formatTimestamp(b.start),
              meter,
              series[i],
              b.costCents > 0 ? (b.costCents / 100).toFixed(2) : '',
            ]),
          )
          return
        }

        // -- TTY: summary fields + coral line chart inside a panel ------------
        const { Panel, Field } = await import('../ui/Panel.js')
        const { Box, Text } = await import('ink')
        const { theme } = await import('../ui/theme.js')

        const meterLabel = meter === 'cost' ? 'spend ($)' : meter
        const chart = renderChart(series, {
          caption: `${meterLabel} per ${cleanDuration(ts.bucket)}, last ${window}`,
          empty: 'No usage in this window.',
          format: meter === 'cost' ? (v) => `$${v.toFixed(2)}` : undefined,
        })

        await renderStatic(
          <Panel title="Usage" subtitle={`last ${window}`}>
            <Field label="tokens" value={fmtCompact(totTokens)} />
            <Field label="runs" value={String(totRuns)} />
            {totFailed > 0 ? (
              <Field label="failed" value={String(totFailed)} valueColor={theme.destructive} />
            ) : null}
            {totCents > 0 ? <Field label="spend" value={fmtUSD(totCents)} /> : null}
            {meters ? (
              <>
                <Field label="tool calls" value={fmtCompact(meters.totals.toolCalls)} />
                <Field
                  label="sandbox"
                  value={`${meters.totals.sandboxSeconds.toFixed(1)}s`}
                />
              </>
            ) : (
              <Field label="meters" value="tool-call / sandbox unavailable" valueColor={theme.subtle} />
            )}
            <Box marginTop={1} flexDirection="column">
              <Text>{chart}</Text>
            </Box>
          </Panel>,
        )
      },
    )
}
