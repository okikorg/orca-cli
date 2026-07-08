import type { Command } from 'commander'

import { formatTimestamp } from '../lib/format.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { assertWindow } from '../lib/window.js'
import { statusColor } from '../ui/theme.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// -- Wire shapes (subset of the conductor stats DTOs) ------------------------
// Anchored on agent-runtime/runtime/httpapi/stats.go: statsSummaryDTO (:30),
// statsAgentDTO/statsAgentsResponseDTO (:48,:64), and statsHotspotsDTO (:105).
// All four endpoints (GET /api/stats/{summary,agents,hotspots}) are tenant-key
// accessible; the window token is parsed by parseStatsWindow (stats.go :494).
// This command COMPLEMENTS `orca usage` (which owns the timeseries chart and
// spend): it renders the summary snapshot, the per-agent breakdown, and the
// activity hotspots. Cost is intentionally absent here: neither statsTotalsDTO
// nor statsAgentDTO carries a cost field (only timeseries buckets do), so spend
// stays in `orca usage`.

type Usage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
}

type StatsTotals = {
  agents: number
  sessions: number
  liveSessions: number
  runs: number
  runningRuns: number
  failedRuns: number
  cancelledRuns: number
  tokens: Usage
  errorRate: number
  p95RunDurationMs: number
}

type RunnerPoolStats = {
  available: boolean
  runners: number
  healthyRunners: number
  activeSessions: number
}

type StatsSummary = {
  window: string
  since: string
  until: string
  totals: StatsTotals
  sessionStatusCounts: Record<string, number>
  runStatusCounts: Record<string, number>
  runnerPool: RunnerPoolStats
}

type StatsAgent = {
  name: string
  runtime: string
  sessions: number
  liveSessions: number
  runningSessions: number
  erroredSessions: number
  runs: number
  runningRuns: number
  failedRuns: number
  cancelledRuns: number
  tokens: Usage
  lastActivityAt?: string
  p95RunDurationMs: number
}

type StatsAgentsResponse = {
  window: string
  since: string
  until: string
  total: number
  limit: number
  offset: number
  sort: string
  agents: StatsAgent[]
}

type StatsHotspot = {
  kind: string
  name: string
  runtime?: string
  value: number
  tokens?: Usage
  lastEventAt?: string
}

type StatsHotspots = {
  window: string
  since: string
  until: string
  tokenConsumers: StatsHotspot[]
  failingAgents: StatsHotspot[]
  busyRunners: StatsHotspot[]
  longSessions: StatsHotspot[]
}

const DEFAULT_WINDOW = '24h'

function totalTokens(u: Usage): number {
  return (
    (u.inputTokens ?? 0) +
    (u.outputTokens ?? 0) +
    (u.cacheReadTokens ?? 0) +
    (u.cacheCreateTokens ?? 0)
  )
}

// fmtCompact renders large counts as 1.2k / 3.4M, matching the dashboard.
function fmtCompact(n: number): string {
  if (n === 0) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

// fmtDuration compacts a millisecond duration to ms / s / m for display.
function fmtDuration(ms: number): string {
  if (ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

function fmtLast(iso?: string): string {
  return iso ? formatTimestamp(iso) : '-'
}

function window(opts: { window?: string }): string {
  return opts.window && opts.window.trim() ? assertWindow(opts.window.trim()) : DEFAULT_WINDOW
}

// -- per-agent table (shared by `orca stats` and `orca stats agents`) --------

async function renderAgentTable(agents: StatsAgent[], w: string, title: string): Promise<void> {
  const { Table } = await import('../ui/Table.js')
  const { Panel } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title={title} subtitle={`last ${w}`}>
      <Table
        columns={[
          { header: 'agent', get: (a: StatsAgent) => a.name, color: () => theme.accent, bold: true },
          { header: 'runtime', get: (a: StatsAgent) => a.runtime || '-' },
          { header: 'runs', get: (a: StatsAgent) => String(a.runs) },
          {
            header: 'failed',
            get: (a: StatsAgent) => String(a.failedRuns),
            color: (a: StatsAgent) => (a.failedRuns > 0 ? statusColor('error') : theme.subtle),
          },
          { header: 'tokens', get: (a: StatsAgent) => fmtCompact(totalTokens(a.tokens)) },
          { header: 'last active', get: (a: StatsAgent) => fmtLast(a.lastActivityAt) },
        ]}
        rows={agents}
      />
    </Panel>,
  )
}

function agentPlainRows(agents: StatsAgent[]): (string | number)[][] {
  return agents.map((a) => [
    a.name,
    a.runtime || '-',
    a.runs,
    a.failedRuns,
    totalTokens(a.tokens),
    fmtLast(a.lastActivityAt),
  ])
}

// -- hotspots ----------------------------------------------------------------

// The four hotspot lists carry different value semantics, so each is labelled
// with its unit rather than sharing one ambiguous "value" column.
const HOTSPOT_SECTIONS: { key: keyof StatsHotspots; label: string; unit: (v: number) => string }[] = [
  { key: 'tokenConsumers', label: 'top token consumers', unit: (v) => `${fmtCompact(v)} tokens` },
  { key: 'failingAgents', label: 'failing agents', unit: (v) => `${v} failures` },
  { key: 'busyRunners', label: 'busy runners', unit: (v) => `${v} sessions` },
  { key: 'longSessions', label: 'long sessions', unit: (v) => `${v}m` },
]

async function renderHotspots(h: StatsHotspots, w: string): Promise<void> {
  const { Panel } = await import('../ui/Panel.js')
  const { Box, Text } = await import('ink')
  const { theme } = await import('../ui/theme.js')

  const sections = HOTSPOT_SECTIONS.map((s) => ({ ...s, rows: h[s.key] as StatsHotspot[] })).filter(
    (s) => s.rows.length > 0,
  )

  if (sections.length === 0) {
    console.error('No hotspots in this window.')
    return
  }

  await renderStatic(
    <Panel title="HOTSPOTS" subtitle={`last ${w}`}>
      {sections.map((s, i) => (
        <Box key={s.key} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <Text color={theme.subtle}>{s.label}</Text>
          {s.rows.map((row) => (
            <Box key={row.name}>
              <Box width={28}>
                <Text color={theme.accent}>{row.name}</Text>
              </Box>
              <Text color={theme.muted}>{s.unit(row.value)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Panel>,
  )
}

function hotspotPlainRows(h: StatsHotspots): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const s of HOTSPOT_SECTIONS) {
    for (const row of h[s.key] as StatsHotspot[]) rows.push([s.key, row.kind, row.name, row.value])
  }
  return rows
}

export function registerStats(program: Command): void {
  const stats = program
    .command('stats')
    .description('activity, agent, and hotspot statistics for the tenant')
    .option('--window <w>', 'look-back window: 1h, 24h, 7d, 30d (default 24h)')
    .action(async (opts: { window?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const w = window(opts)
      const api = await apiContext(cmd)
      const mode = outputMode(flags)

      const summary = await withApi(api, (c) =>
        c.request<StatsSummary>(`/api/stats/summary?window=${encodeURIComponent(w)}`),
      )

      if (mode === 'plain') {
        // Single-shape key/value totals (grep-friendly). Per-agent rows live
        // under `orca stats agents`, hotspots under `orca stats hotspots`.
        const t = summary.totals
        const p = summary.runnerPool
        printPlainRows([
          ['window', summary.window],
          ['agents', t.agents],
          ['sessions', t.sessions],
          ['liveSessions', t.liveSessions],
          ['runs', t.runs],
          ['runningRuns', t.runningRuns],
          ['failedRuns', t.failedRuns],
          ['cancelledRuns', t.cancelledRuns],
          ['tokens', totalTokens(t.tokens)],
          ['errorRate', t.errorRate.toFixed(4)],
          ['p95RunDurationMs', Math.round(t.p95RunDurationMs)],
          ['runners', p.runners],
          ['healthyRunners', p.healthyRunners],
        ])
        return
      }

      // Agents and hotspots are additive context; degrade rather than fail the
      // whole view if either endpoint is unavailable.
      let agents: StatsAgent[] = []
      let hotspots: StatsHotspots | null = null
      try {
        agents = (
          await api.client.request<StatsAgentsResponse>(
            `/api/stats/agents?window=${encodeURIComponent(w)}`,
          )
        ).agents
      } catch {
        agents = []
      }
      try {
        hotspots = await api.client.request<StatsHotspots>(
          `/api/stats/hotspots?window=${encodeURIComponent(w)}`,
        )
      } catch {
        hotspots = null
      }

      if (mode === 'json') {
        printJson({ window: w, summary, agents, hotspots })
        return
      }

      // -- TTY: summary panel, then per-agent table, then hotspots ----------
      const { Panel, Field } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      const t = summary.totals
      const p = summary.runnerPool
      await renderStatic(
        <Panel title="STATS" subtitle={`last ${summary.window}`}>
          <Field label="agents" value={String(t.agents)} />
          <Field label="sessions" value={`${t.liveSessions} live / ${t.sessions}`} />
          <Field label="runs" value={String(t.runs)} />
          {t.runningRuns > 0 ? (
            <Field label="running" value={String(t.runningRuns)} valueColor={theme.accent} />
          ) : null}
          {t.failedRuns > 0 ? (
            <Field label="failed" value={String(t.failedRuns)} valueColor={theme.destructive} />
          ) : null}
          {t.cancelledRuns > 0 ? <Field label="cancelled" value={String(t.cancelledRuns)} /> : null}
          <Field label="tokens" value={fmtCompact(totalTokens(t.tokens))} />
          <Field label="error rate" value={fmtPct(t.errorRate)} />
          <Field label="p95 run" value={fmtDuration(t.p95RunDurationMs)} />
          {p.available ? (
            <Field label="runners" value={`${p.healthyRunners}/${p.runners} healthy`} />
          ) : null}
          {p.available && p.activeSessions > 0 ? (
            <Field label="active" value={`${p.activeSessions} sessions`} />
          ) : null}
        </Panel>,
      )

      if (agents.length > 0) await renderAgentTable(agents, summary.window, 'AGENTS')
      if (hotspots) await renderHotspots(hotspots, summary.window)
    })

  stats
    .command('agents')
    .description('per-agent statistics breakdown')
    .option('--window <w>', 'look-back window: 1h, 24h, 7d, 30d (default 24h)')
    .action(async (opts: { window?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const w = window(opts)
      const api = await apiContext(cmd)
      const res = await withApi(api, (c) =>
        c.request<StatsAgentsResponse>(`/api/stats/agents?window=${encodeURIComponent(w)}`),
      )
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(res)
        return
      }
      if (mode === 'plain') {
        printPlainRows(agentPlainRows(res.agents))
        return
      }
      if (res.agents.length === 0) {
        console.error('No agent activity in this window.')
        return
      }
      await renderAgentTable(res.agents, res.window, 'AGENTS')
    })

  stats
    .command('hotspots')
    .description('top contributors by tokens, failures, runner load, and session age')
    .option('--window <w>', 'look-back window: 1h, 24h, 7d, 30d (default 24h)')
    .action(async (opts: { window?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const w = window(opts)
      const api = await apiContext(cmd)
      const h = await withApi(api, (c) =>
        c.request<StatsHotspots>(`/api/stats/hotspots?window=${encodeURIComponent(w)}`),
      )
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(h)
        return
      }
      if (mode === 'plain') {
        printPlainRows(hotspotPlainRows(h))
        return
      }
      await renderHotspots(h, h.window)
    })
}
