import type { Command } from 'commander'

import { ApiError, mapApiError } from '../lib/api.js'
import { CliError, ExitCode } from '../lib/errors.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderStatic,
} from '../lib/output.js'
import type { AgentProfile, MCPServerSpec } from '../lib/types.js'
import { confirm } from './prompts.js'
import {
  addPageFlags,
  apiContext,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type ApiContext,
  type PageFlags,
} from './shared.js'

// A catalog entry is a reusable MCPServerSpec plus an optional human
// description, managed via the tenant-scoped /api/mcp-servers surface. The
// runtime copies entries into a profile's mcpServers at attach time; it does
// not consult the catalog at run time.
type MCPServerCatalogEntry = MCPServerSpec & { description?: string }

// The probe result returned by POST /api/mcp-servers/test.
type MCPTestResult = {
  ok: boolean
  error?: string
  latencyMs: number
  toolCount?: number
  tools?: string[]
}

// MCP server names are injected unescaped into the codex runtime's TOML
// config keys (mcp_servers.<name>.url=...), so a name with TOML-unsafe
// characters is a config-injection risk. The worker rejects these at run
// time; we reject them here so the user gets a precise error before the
// name is ever persisted. This is stricter than the conductor's own
// validateMCPServerSpec (which only bars empty and "runner").
const SAFE_MCP_NAME = /^[A-Za-z0-9_-]+$/

function assertValidName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new CliError('--name is required', ExitCode.Usage)
  if (name === 'runner') {
    throw new CliError('mcp server name "runner" is reserved', ExitCode.Usage)
  }
  if (!SAFE_MCP_NAME.test(name)) {
    throw new CliError(`invalid mcp server name "${name}"`, ExitCode.Usage, [
      'Names must match ^[A-Za-z0-9_-]+$ (letters, digits, underscore, hyphen).',
    ])
  }
  return name
}

function assertHttpUrl(raw: string): string {
  const url = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new CliError(`--url must be an absolute http(s) URL, got "${raw}"`, ExitCode.Usage)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(`--url must be an absolute http(s) URL, got "${raw}"`, ExitCode.Usage)
  }
  return url
}

function assertTransport(raw: string): 'http' | 'sse' {
  if (raw !== 'http' && raw !== 'sse') {
    throw new CliError('--transport must be "http" or "sse"', ExitCode.Usage)
  }
  return raw
}

// collectHeader is the commander reducer for the repeatable --header flag.
function collectHeader(value: string, acc: string[]): string[] {
  acc.push(value)
  return acc
}

// parseHeaders turns ["KEY=VALUE", ...] into a header map. Values may carry
// "${VAR}" env references or "secret://name" secret references, which the
// runtime resolves; we pass them through verbatim. Returns undefined for an
// empty list so we never write an empty headers object into the wire body.
function parseHeaders(pairs: string[]): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new CliError(`--header must be KEY=VALUE, got "${pair}"`, ExitCode.Usage)
    }
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1)
  }
  return out
}

// headerCell renders a server's header keys (never values) for list/detail
// views. Values may be secrets, so only key names are shown.
function headerCell(s: { headers?: Record<string, string> }): string {
  const keys = s.headers ? Object.keys(s.headers) : []
  return keys.length > 0 ? keys.join(',') : '-'
}

function catalogPath(name: string): string {
  return `/api/mcp-servers/${encodeURIComponent(name)}`
}

// runOrTranslate409 runs a mutating catalog request and maps a 409 (name
// already registered) onto the usage exit code with a hint, rather than the
// generic failure mapApiError would produce.
async function runOrTranslate409<T>(
  api: ApiContext,
  fn: (client: ApiContext['client']) => Promise<T>,
  conflictMessage: string,
  hint?: string[],
): Promise<T> {
  try {
    return await fn(api.client)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new CliError(conflictMessage, ExitCode.Usage, hint)
    }
    throw mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
  }
}

async function renderCatalogDetail(e: MCPServerCatalogEntry): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  await renderStatic(
    <Panel title={e.name} subtitle={e.transport}>
      <Field label="url" value={e.url} />
      <Field label="headers" value={headerCell(e)} />
      {e.description ? <Field label="description" value={e.description} /> : null}
    </Panel>,
  )
}

async function renderTestResult(r: MCPTestResult): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title="MCP PROBE" subtitle={r.ok ? 'ok' : 'failed'}>
      <Field
        label="status"
        value={r.ok ? 'ok' : 'failed'}
        valueColor={r.ok ? theme.accent : theme.destructive}
      />
      <Field label="latency" value={`${r.latencyMs}ms`} />
      <Field label="tools" value={String(r.toolCount ?? r.tools?.length ?? 0)} />
      {r.tools?.length ? <Field label="names" value={r.tools.join(', ')} /> : null}
      {r.error ? <Field label="error" value={r.error} valueColor={theme.destructive} /> : null}
    </Panel>,
  )
}

export function registerMcp(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('manage MCP servers in the tenant catalog and on agent profiles')

  // -- Catalog: list ----------------------------------------------------------
  const mcpList = mcp.command('list').description('list MCP catalog entries')
  addPageFlags(mcpList)
  mcpList.action(async (opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<MCPServerCatalogEntry>(opts, (params) =>
        withApi(api, (c) => c.listMcpServers<MCPServerCatalogEntry>(params)),
      )
      const entries = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(entries)
        return
      }
      if (entries.length === 0) {
        console.error('No MCP servers. Register one with: orca mcp add --name N --url URL')
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          entries.map((e) => [e.name, e.transport, e.url, e.description ?? '-']),
        )
        printPageHint(entries.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="MCP SERVERS" subtitle={pagedSubtitle(entries.length, page.total)}>
          <Table
            columns={[
              {
                header: 'name',
                get: (e: MCPServerCatalogEntry) => e.name,
                color: () => theme.accent,
                bold: true,
              },
              { header: 'transport', get: (e: MCPServerCatalogEntry) => e.transport },
              { header: 'url', get: (e: MCPServerCatalogEntry) => e.url },
              { header: 'description', get: (e: MCPServerCatalogEntry) => e.description ?? '-' },
            ]}
            rows={entries}
          />
        </Panel>,
      )
      printPageHint(entries.length, page.total)
    })

  // -- Catalog: get -----------------------------------------------------------
  mcp
    .command('get <name>')
    .description('show one MCP catalog entry')
    .action(async (name: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const entry = await withApi(api, (c) =>
        c.request<MCPServerCatalogEntry>(catalogPath(name)),
      )
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(entry)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['name', entry.name],
          ['transport', entry.transport],
          ['url', entry.url],
          ['headers', headerCell(entry)],
          ['description', entry.description ?? '-'],
        ])
        return
      }
      await renderCatalogDetail(entry)
    })

  // -- Catalog: add -----------------------------------------------------------
  mcp
    .command('add')
    .description('register a new MCP catalog entry')
    .requiredOption('--name <name>', 'server name (must match ^[A-Za-z0-9_-]+$)')
    .requiredOption('--url <url>', 'absolute http(s) MCP endpoint URL')
    .option('--transport <transport>', 'http | sse', 'http')
    .option('--header <kv>', 'header as KEY=VALUE (repeatable)', collectHeader, [])
    .option('--description <text>', 'human-readable description')
    .action(
      async (
        opts: {
          name: string
          url: string
          transport: string
          header: string[]
          description?: string
        },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        const name = assertValidName(opts.name)
        const url = assertHttpUrl(opts.url)
        const transport = assertTransport(opts.transport)
        const headers = parseHeaders(opts.header)
        const entry: MCPServerCatalogEntry = {
          name,
          transport,
          url,
          ...(headers ? { headers } : {}),
          ...(opts.description ? { description: opts.description } : {}),
        }
        const created = await runOrTranslate409(
          api,
          (c) =>
            c.request<MCPServerCatalogEntry>('/api/mcp-servers', {
              method: 'POST',
              body: JSON.stringify(entry),
            }),
          `an MCP server named "${name}" is already registered`,
          [`Update it with: orca mcp set ${name} ...`],
        )
        if (outputMode(flags) === 'json') {
          printJson(created ?? entry)
          return
        }
        console.log(`Registered MCP server "${name}" (${transport}).`)
      },
    )

  // -- Catalog: set -----------------------------------------------------------
  mcp
    .command('set <name>')
    .description('update or rename an MCP catalog entry')
    .option('--rename <newName>', 'rename the entry (must match ^[A-Za-z0-9_-]+$)')
    .option('--url <url>', 'new absolute http(s) URL')
    .option('--transport <transport>', 'http | sse')
    .option('--header <kv>', 'header as KEY=VALUE (repeatable); replaces all headers', collectHeader, [])
    .option('--clear-headers', 'remove all headers')
    .option('--description <text>', 'new description (empty string clears it)')
    .action(
      async (
        name: string,
        opts: {
          rename?: string
          url?: string
          transport?: string
          header: string[]
          clearHeaders?: boolean
          description?: string
        },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        const hasChange =
          opts.rename !== undefined ||
          opts.url !== undefined ||
          opts.transport !== undefined ||
          opts.header.length > 0 ||
          opts.clearHeaders === true ||
          opts.description !== undefined
        if (!hasChange) {
          throw new CliError(
            'nothing to update; pass --url, --transport, --header, --description, or --rename',
            ExitCode.Usage,
          )
        }
        const current = await withApi(api, (c) =>
          c.request<MCPServerCatalogEntry>(catalogPath(name)),
        )
        const next: MCPServerCatalogEntry = { ...current }
        if (opts.rename !== undefined) next.name = assertValidName(opts.rename)
        if (opts.url !== undefined) next.url = assertHttpUrl(opts.url)
        if (opts.transport !== undefined) next.transport = assertTransport(opts.transport)
        if (opts.clearHeaders) {
          delete next.headers
        } else if (opts.header.length > 0) {
          next.headers = parseHeaders(opts.header)
        }
        if (opts.description !== undefined) {
          if (opts.description === '') delete next.description
          else next.description = opts.description
        }
        const updated = await runOrTranslate409(
          api,
          (c) =>
            c.request<MCPServerCatalogEntry>(catalogPath(name), {
              method: 'PUT',
              body: JSON.stringify(next),
            }),
          `an MCP server named "${next.name}" already exists`,
        )
        if (outputMode(flags) === 'json') {
          printJson(updated ?? next)
          return
        }
        console.log(
          `Updated MCP server "${name}"${opts.rename ? ` -> "${next.name}"` : ''}.`,
        )
      },
    )

  // -- Catalog: remove --------------------------------------------------------
  mcp
    .command('remove <name>')
    .description('delete an MCP catalog entry')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete MCP server "${name}"?`))) {
          console.error('Aborted.')
          return
        }
      }
      await withApi(api, (c) => c.request<void>(catalogPath(name), { method: 'DELETE' }))
      if (outputMode(flags) === 'json') printJson({ name, deleted: true })
      else console.log(`Deleted MCP server "${name}".`)
    })

  // -- Catalog: test ----------------------------------------------------------
  mcp
    .command('test [name]')
    .description('probe an MCP server (a registered entry by NAME, or an ad-hoc --url)')
    .option('--url <url>', 'probe an unregistered endpoint URL instead of a catalog entry')
    .option('--transport <transport>', 'http | sse (with --url)', 'http')
    .option('--header <kv>', 'header as KEY=VALUE (repeatable, with --url)', collectHeader, [])
    .action(
      async (
        name: string | undefined,
        opts: { url?: string; transport: string; header: string[] },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        let spec: MCPServerSpec
        if (name) {
          if (opts.url) {
            throw new CliError('pass either a NAME or --url, not both', ExitCode.Usage)
          }
          const entry = await withApi(api, (c) =>
            c.request<MCPServerCatalogEntry>(catalogPath(name)),
          )
          spec = {
            name: entry.name,
            transport: entry.transport,
            url: entry.url,
            ...(entry.headers ? { headers: entry.headers } : {}),
          }
        } else if (opts.url) {
          const headers = parseHeaders(opts.header)
          spec = {
            name: 'probe',
            transport: assertTransport(opts.transport),
            url: assertHttpUrl(opts.url),
            ...(headers ? { headers } : {}),
          }
        } else {
          throw new CliError('provide a registered NAME or --url to probe', ExitCode.Usage)
        }
        const result = await withApi(api, (c) =>
          c.request<MCPTestResult>('/api/mcp-servers/test', {
            method: 'POST',
            body: JSON.stringify(spec),
          }),
        )
        const mode = outputMode(flags)
        if (mode === 'json') {
          printJson(result)
        } else if (mode === 'plain') {
          printPlainRows([
            ['ok', String(result.ok)],
            ['latencyMs', String(result.latencyMs)],
            ['tools', String(result.toolCount ?? result.tools?.length ?? 0)],
            ...(result.error ? [['error', result.error]] : []),
          ])
        } else {
          await renderTestResult(result)
        }
        // A reachable-but-broken probe returns 200 with ok:false; surface it
        // as a non-zero exit so scripts can gate on connectivity.
        if (!result.ok) {
          throw new CliError(
            result.error ? `probe failed: ${result.error}` : 'probe failed',
            ExitCode.Failure,
          )
        }
      },
    )

  // -- Profile: attach --------------------------------------------------------
  mcp
    .command('attach <agent> <name>')
    .description("copy a catalog entry onto an agent profile's mcpServers")
    .action(async (agent: string, name: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const entry = await withApi(api, (c) =>
        c.request<MCPServerCatalogEntry>(catalogPath(name)),
      )
      const profile = await withApi(api, (c) => c.getProfile(agent))
      const servers = profile.mcpServers ? [...profile.mcpServers] : []
      if (servers.some((s) => s.name === entry.name)) {
        throw new CliError(
          `agent "${agent}" already has an MCP server named "${entry.name}"`,
          ExitCode.Usage,
          [`Detach it first: orca mcp detach ${agent} ${entry.name}`],
        )
      }
      const spec: MCPServerSpec = {
        name: entry.name,
        transport: entry.transport,
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers } : {}),
      }
      servers.push(spec)
      const updated: AgentProfile = { ...profile, mcpServers: servers }
      await withApi(api, (c) => c.updateProfile(agent, updated))
      if (outputMode(flags) === 'json') printJson({ agent, server: spec })
      else console.log(`Attached MCP server "${entry.name}" to agent "${agent}".`)
    })

  // -- Profile: detach --------------------------------------------------------
  mcp
    .command('detach <agent> <name>')
    .description("remove an MCP server from an agent profile's mcpServers")
    .option('--yes', 'skip the confirmation prompt')
    .action(async (agent: string, name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes && !interactive()) {
        throw new CliError('refusing to detach without --yes in non-interactive mode', ExitCode.Usage)
      }
      const profile = await withApi(api, (c) => c.getProfile(agent))
      const servers = profile.mcpServers ?? []
      if (!servers.some((s) => s.name === name)) {
        throw new CliError(`agent "${agent}" has no MCP server named "${name}"`, ExitCode.NotFound)
      }
      if (!opts.yes) {
        if (!(await confirm(`Detach MCP server "${name}" from agent "${agent}"?`))) {
          console.error('Aborted.')
          return
        }
      }
      const updated: AgentProfile = {
        ...profile,
        mcpServers: servers.filter((s) => s.name !== name),
      }
      await withApi(api, (c) => c.updateProfile(agent, updated))
      if (outputMode(flags) === 'json') printJson({ agent, name, detached: true })
      else console.log(`Detached MCP server "${name}" from agent "${agent}".`)
    })
}
