import type { Command } from 'commander'

import { ApiError, mapApiError } from '../lib/api.js'
import { requireApiUrl, resolveContext } from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { ansi, colorEnabled, glyphs, hintText } from '../ui/theme.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// -- Wire shapes -------------------------------------------------------------
// RunnerTopology: agent-runtime/runtime/remote/pool.go :53 (GET /api/topology,
// an array; 404 in single-runner mode). CapabilityBundleInfo:
// runtime/toolkit/toolkit.go :134 (GET /api/capability-bundles wraps it in
// {bundles}). providerDTO + pg.AppConnection: runtime/httpapi/connected_apps.go
// :69 and runtime/storage/pg/connections_repo.go :23 (GET
// /api/connected-apps/{providers,connections}, each wrapped in a named key).

type RunnerTopology = {
  hash: string
  url: string
  healthy: boolean
  latencyMs?: number
  activeSessions: number
  error?: string
  capabilities?: string[]
}

type CapabilityBundle = {
  value: string
  label: string
  description: string
}

type ConnectedProvider = {
  name: string
  configured: boolean
}

type AppConnection = {
  id: string
  provider: string
  appSlug: string
  scope: string
  status: string
  mcpServerName?: string
  createdAt: string
}

// -- topology tree (pure, testable string like lib/chart.ts) -----------------

function tint(text: string, code: string, color: boolean): string {
  if (!color || !code) return text
  return `${code}${text}${ansi.reset}`
}

// renderTopologyTree draws the runner pool as an indented tree in the
// WorkflowTail StepTree idiom: a coral "conductor" root, subtle tree-branch
// connectors, each runner's hash in coral, health colored, details gray. The
// edge glyph comes from the active theme tier (box-drawing `├` on Unicode, the
// `|-` fallback on ASCII) - never hardcoded here. Kept pure (no Ink) so it is
// unit-testable and embeds verbatim in a <Text> block, exactly like
// renderChart.
export function renderTopologyTree(
  runners: RunnerTopology[],
  opts: { color?: boolean } = {},
): string {
  const color = opts.color ?? colorEnabled()
  const branch = `${glyphs.treeBranch} `
  const healthy = runners.filter((r) => r.healthy).length
  const summary = `  ${runners.length} runner${runners.length === 1 ? '' : 's'}, ${healthy} healthy`
  const lines = [tint('conductor', ansi.accent, color) + tint(summary, ansi.subtle, color)]

  if (runners.length === 0) {
    lines.push(tint(branch, ansi.subtle, color) + tint('(no runners registered)', ansi.subtle, color))
    return lines.join('\n')
  }

  const hashWidth = Math.min(24, Math.max(...runners.map((r) => r.hash.length)))
  for (const r of runners) {
    const hash = r.hash.padEnd(hashWidth)
    const state = r.healthy ? 'healthy' : 'down'
    const stateCode = r.healthy ? ansi.accent : ansi.destructive
    const detail: string[] = [`${r.activeSessions} sessions`]
    if (r.latencyMs != null) detail.push(`${r.latencyMs}ms`)
    if (r.error) detail.push(r.error)
    lines.push(
      tint(branch, ansi.subtle, color) +
        tint(hash, ansi.accent, color) +
        '  ' +
        tint(state.padEnd(8), stateCode, color) +
        tint(detail.join('  '), ansi.subtle, color),
    )
  }
  return lines.join('\n')
}

function topologyPlainRows(runners: RunnerTopology[]): (string | number)[][] {
  return runners.map((r) => [
    r.hash,
    r.url,
    r.healthy ? 'healthy' : 'down',
    r.activeSessions,
    r.latencyMs ?? '',
    r.error ?? '',
  ])
}

function registerTopology(program: Command): void {
  program
    .command('topology')
    .description('live view of the conductor runner pool')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const runners = await withApi(api, (c) => c.request<RunnerTopology[]>('/api/topology'))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(runners)
        return
      }
      if (mode === 'plain') {
        printPlainRows(topologyPlainRows(runners))
        return
      }
      const { Panel } = await import('../ui/Panel.js')
      const { Box, Text } = await import('ink')
      await renderStatic(
        <Panel title="Topology" subtitle={`${runners.length} runner${runners.length === 1 ? '' : 's'}`}>
          <Box flexDirection="column">
            <Text>{renderTopologyTree(runners)}</Text>
          </Box>
        </Panel>,
      )
    })
}

// -- ping --------------------------------------------------------------------

type PingResult = {
  apiUrl: string
  ok: boolean
  status: number | null
  latencyMs: number | null
  error?: string
}

function registerPing(program: Command): void {
  program
    .command('ping')
    .description('probe the conductor /healthz endpoint and report round-trip latency')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      // /healthz needs no auth, so resolve the URL without requiring a key.
      const ctx = await resolveContext(flags)
      const apiUrl = requireApiUrl(ctx)
      const mode = outputMode(flags)

      const started = performance.now()
      let result: PingResult
      try {
        const res = await fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(10_000) })
        const latencyMs = Math.round(performance.now() - started)
        result = { apiUrl, ok: res.ok, status: res.status, latencyMs }
      } catch (err) {
        result = {
          apiUrl,
          ok: false,
          status: null,
          latencyMs: null,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      if (mode === 'json') {
        printJson(result)
      } else if (mode === 'plain') {
        printPlainRows([
          [result.ok ? 'ok' : 'unreachable', result.status ?? '', result.latencyMs ?? ''],
        ])
      } else {
        const { Panel, Field } = await import('../ui/Panel.js')
        const { theme } = await import('../ui/theme.js')
        await renderStatic(
          <Panel title="Ping" subtitle={ctx.name}>
            <Field label="api url" value={apiUrl} />
            <Field
              label="status"
              value={result.ok ? 'healthy' : 'unhealthy'}
              valueColor={result.ok ? theme.accent : theme.destructive}
            />
            {result.status != null ? <Field label="http" value={String(result.status)} /> : null}
            {result.latencyMs != null ? (
              <Field label="latency" value={`${result.latencyMs}ms`} />
            ) : null}
            {result.error ? <Field label="error" value={result.error} valueColor={theme.subtle} /> : null}
          </Panel>,
        )
      }

      // Exit-code contract: 0 healthy, 1 unhealthy/unreachable. Output above is
      // already on the wire; the throw only sets the exit code (message to
      // stderr, stdout stays clean).
      if (!result.ok) {
        throw new CliError(
          result.error ? `conductor unreachable: ${result.error}` : `conductor unhealthy (HTTP ${result.status})`,
          ExitCode.Failure,
        )
      }
    })
}

// -- capability bundles ------------------------------------------------------

function registerBundles(program: Command): void {
  program
    .command('bundles')
    .description('list the capability bundles agents can attach (@fs, @memory, ...)')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const bundles = (
        await withApi(api, (c) =>
          c.request<{ bundles: CapabilityBundle[] }>('/api/capability-bundles'),
        )
      ).bundles
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(bundles)
        return
      }
      if (mode === 'plain') {
        printPlainRows(bundles.map((b) => [b.value, b.label, b.description]))
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="Capability bundles" subtitle={`${bundles.length} total`}>
          <Table
            headers
            columns={[
              { header: 'bundle', get: (b: CapabilityBundle) => b.value, color: () => theme.accent, bold: true },
              { header: 'label', get: (b: CapabilityBundle) => b.label },
              { header: 'description', get: (b: CapabilityBundle) => b.description },
            ]}
            rows={bundles}
          />
        </Panel>,
      )
    })
}

// -- connected apps (read-only) ----------------------------------------------

// softRequest degrades a "not configured" 503 into a fallback so `orca apps`
// still renders on a conductor without the Connected Apps registry wired.
// Auth (401/403) and other failures still surface via mapApiError.
async function softRequest<T>(api: Awaited<ReturnType<typeof apiContext>>, path: string, fallback: T): Promise<T> {
  try {
    return await api.client.request<T>(path)
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) return fallback
    throw mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
  }
}

function registerApps(program: Command): void {
  program
    .command('apps')
    .description('list Connected Apps providers and connections (read-only)')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const providers = (
        await softRequest<{ providers: ConnectedProvider[] }>(
          api,
          '/api/connected-apps/providers',
          { providers: [] },
        )
      ).providers
      const connections = (
        await softRequest<{ connections: AppConnection[] }>(
          api,
          '/api/connected-apps/connections',
          { connections: [] },
        )
      ).connections
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson({ providers, connections })
        return
      }
      if (mode === 'plain') {
        // A leading discriminator column keeps the mixed shapes parseable.
        const rows: (string | number)[][] = []
        for (const p of providers) rows.push(['provider', p.name, p.configured ? 'configured' : 'not-configured'])
        for (const c of connections) rows.push(['connection', c.id, c.provider, c.appSlug, c.status])
        printPlainRows(rows)
        return
      }

      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')

      if (providers.length === 0 && connections.length === 0) {
        console.error(hintText('No Connected Apps providers configured (set COMPOSIO_API_KEY on the conductor).'))
        return
      }

      if (providers.length > 0) {
        await renderStatic(
          <Panel title="Connected app providers" subtitle={`${providers.length} total`}>
            <Table
              columns={[
                { header: 'provider', get: (p: ConnectedProvider) => p.name, color: () => theme.accent, bold: true },
                {
                  header: 'configured',
                  get: (p: ConnectedProvider) => (p.configured ? 'yes' : 'no'),
                  color: (p: ConnectedProvider) => (p.configured ? theme.accent : theme.subtle),
                },
              ]}
              rows={providers}
            />
          </Panel>,
        )
      }
      if (connections.length > 0) {
        await renderStatic(
          <Panel title="Connections" subtitle={`${connections.length} total`}>
            <Table
              headers
              columns={[
                { header: 'id', get: (c: AppConnection) => c.id, color: () => theme.accent, bold: true },
                { header: 'provider', get: (c: AppConnection) => c.provider },
                { header: 'app', get: (c: AppConnection) => c.appSlug },
                { header: 'scope', get: (c: AppConnection) => c.scope },
                { header: 'status', get: (c: AppConnection) => c.status },
              ]}
              rows={connections}
            />
          </Panel>,
        )
      }
    })
}

export function registerPlatform(program: Command): void {
  registerTopology(program)
  registerPing(program)
  registerBundles(program)
  registerApps(program)
}
