// Orca's control-plane MCP server (stdio), mounted by `orca mcp serve`.
//
// This is how coding agents (Claude Code, Cursor, Codex) drive Orca without
// shelling out per call: a curated tool per golden-path verb, one raw
// `api_request` escape hatch that reaches every /api/* operation, and an
// `orca://openapi` resource so the escape hatch is self-documenting.
//
// Design rules:
// - stdio discipline: nothing but JSON-RPC on stdout. Every tool failure is
//   an in-band MCP error result (isError: true) whose text contains the fix,
//   because agents act on error text. The process never mounts Ink.
// - context economy: compact JSON, capped arrays and byte sizes, described
//   truncation. MCP tools are request/response, so run-following is the
//   `wait_for_run` long-poll over the conductor's SSE stream.
// - auth is the CLI's own: flag > ORCA_API_KEY > ~/.config/orca contexts,
//   resolved lazily so `claude mcp add` can register the server before the
//   user has logged in.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient, ApiError } from '../lib/api.js'
import { resolveContext, type GlobalFlags } from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { streamRunEvents } from '../lib/sse.js'
import type { RunEvent, SubTask } from '../lib/types.js'

// Result payloads are capped so one tool call cannot flood an agent's
// context window. Truncation is always announced in the payload.
const MAX_RESULT_BYTES = 50_000
const MAX_EVENTS_RETURNED = 100
const DEFAULT_STORAGE_READ_BYTES = 65_536

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

// Prefix a result with a warning line the caller should surface. Used where
// the CLI's file-based profile parser would warn but the raw API path (which
// MCP uses) normalizes silently -- e.g. the deprecated "general" runtime.
function jsonResultWithWarning(warning: string, value: unknown): ToolResult {
  const base = jsonResult(value)
  const first = base.content[0]
  if (first?.type === 'text') first.text = `warning: ${warning}\n${first.text}`
  return base
}

function jsonResult(value: unknown): ToolResult {
  let text = JSON.stringify(value, null, 1)
  if (text.length > MAX_RESULT_BYTES) {
    text =
      text.slice(0, MAX_RESULT_BYTES) +
      `\n... [truncated at ${MAX_RESULT_BYTES} bytes; narrow the request (limit, prefix, maxBytes) for the rest]`
  }
  return { content: [{ type: 'text', text }] }
}

function errorResult(message: string, detail?: string[]): ToolResult {
  const text = [message, ...(detail ?? [])].join('\n')
  return { content: [{ type: 'text', text }], isError: true }
}

function describeError(err: unknown): ToolResult {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return errorResult('unauthorized: the stored key was rejected.', [
        'Run: orca login   (or set ORCA_API_KEY)',
      ])
    }
    const body = err.body ? ` ${JSON.stringify(err.body)}` : ''
    return errorResult(`API error ${err.status}:${body || ' ' + err.message}`)
  }
  if (err instanceof CliError) {
    return errorResult(err.message, err.detail)
  }
  return errorResult(err instanceof Error ? err.message : String(err))
}

// clientSource resolves the CLI context lazily and caches the result. A
// missing key is reported per-call with the exact fix, not at startup, so
// registering the server before first login works.
export type ClientSource = () => Promise<ApiClient>

export function makeClientSource(flags: GlobalFlags): ClientSource {
  let cached: ApiClient | null = null
  return async () => {
    if (cached) return cached
    const ctx = await resolveContext(flags)
    if (!ctx.apiUrl || !ctx.apiKey) {
      throw new CliError('not logged in to Orca.', ExitCode.Auth, [
        'Run: orca login   (or set ORCA_API_KEY and ORCA_API_URL)',
      ])
    }
    cached = new ApiClient({
      apiUrl: ctx.apiUrl.replace(/\/+$/, ''),
      apiKey: ctx.apiKey,
      contextName: ctx.name,
    })
    return cached
  }
}

// capEvents keeps the most recent events and says what was dropped.
function capEvents(events: RunEvent[]): { events: RunEvent[]; dropped: number } {
  if (events.length <= MAX_EVENTS_RETURNED) return { events, dropped: 0 }
  return {
    events: events.slice(events.length - MAX_EVENTS_RETURNED),
    dropped: events.length - MAX_EVENTS_RETURNED,
  }
}

// buildMcpServer wires every tool and resource onto a fresh McpServer.
// Exported for tests (driven over an in-memory transport).
export function buildMcpServer(getClient: ClientSource): McpServer {
  const server = new McpServer({ name: 'orca', version: '1.0.0' })

  // tool wraps a handler with the shared error mapping.
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): void => {
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>) => {
      try {
        return await handler(args ?? {})
      } catch (err) {
        return describeError(err)
      }
    })
  }

  // -- Identity and account ---------------------------------------------------

  tool(
    'whoami',
    'Identify the authenticated Orca caller: tenant, role, credential kind, key id. Call this first to confirm auth works.',
    {},
    async () => {
      const client = await getClient()
      try {
        // Raw request rather than a typed client method: /api/whoami ships
        // with the same wave as this server and the typed helper lands in
        // the device-login branch; the raw path keeps the branches unstacked.
        const who = await client.request<Record<string, unknown>>('/api/whoami')
        return jsonResult({ ...who, apiUrl: client.apiUrl, context: client.contextName })
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // Conductor predates /api/whoami; prove auth works instead.
          await client.listProfiles({ limit: 1 })
          return jsonResult({
            apiUrl: client.apiUrl,
            context: client.contextName,
            note: 'authenticated; this conductor predates /api/whoami so tenant details are unavailable',
          })
        }
        throw err
      }
    },
  )

  tool(
    'get_usage',
    'Read the account status: credit wallet balance and the monthly spend cap.',
    {},
    async () => {
      const client = await getClient()
      const [wallet, spendCap] = await Promise.all([
        client.request<unknown>('/api/billing/wallet').catch((e: unknown) => ({ error: String(e) })),
        client.request<unknown>('/api/spend-cap').catch((e: unknown) => ({ error: String(e) })),
      ])
      return jsonResult({ wallet, spendCap })
    },
  )

  // -- Agents (profiles) --------------------------------------------------------

  tool(
    'list_agents',
    'List the agents (profiles) in this Orca tenant.',
    { limit: z.number().int().min(1).max(200).optional().describe('max rows (default 50)') },
    async (args) => {
      const client = await getClient()
      const { items, total } = await client.listProfiles({ limit: (args.limit as number) ?? 50 })
      return jsonResult({ agents: items, total })
    },
  )

  tool(
    'get_agent',
    'Fetch one agent profile by name (model, instructions, skills, tools, everything).',
    { name: z.string().describe('agent profile name') },
    async (args) => {
      const client = await getClient()
      return jsonResult(await client.getProfile(args.name as string))
    },
  )

  tool(
    'create_agent',
    'Create an agent profile. spec is the AgentProfile body (common fields: model, instructions, skills, mcpServers); the full schema is in the orca://openapi resource under #/components/schemas/AgentProfile.',
    {
      name: z.string().describe('unique agent profile name'),
      spec: z.record(z.string(), z.unknown()).optional().describe('AgentProfile fields besides name'),
    },
    async (args) => {
      const client = await getClient()
      const spec = (args.spec as Record<string, unknown>) ?? {}
      const profile = { ...spec, name: args.name as string }
      const result = await client.createProfile(profile as never)
      if (spec.runtime === 'general') {
        return jsonResultWithWarning(
          'runtime "general" is deprecated; the platform imported it as "vercel". Pass runtime "vercel".',
          result,
        )
      }
      return jsonResult(result)
    },
  )

  tool(
    'update_agent',
    'Replace an agent profile (PUT semantics: send the full desired spec, not a patch).',
    {
      name: z.string().describe('agent profile name'),
      spec: z.record(z.string(), z.unknown()).describe('full AgentProfile body to store'),
    },
    async (args) => {
      const client = await getClient()
      const spec = args.spec as Record<string, unknown>
      const profile = { ...spec, name: args.name as string }
      const result = await client.updateProfile(args.name as string, profile as never)
      if (spec.runtime === 'general') {
        return jsonResultWithWarning(
          'runtime "general" is deprecated; the platform imported it as "vercel". Pass runtime "vercel".',
          result,
        )
      }
      return jsonResult(result)
    },
  )

  // -- Runs ---------------------------------------------------------------------

  tool(
    'run_agent',
    'Start an agent run with a prompt. Returns {runId, sessionId} immediately; call wait_for_run to follow it. Pass sessionId to continue an existing conversation.',
    {
      agent: z.string().describe('agent profile name to run'),
      prompt: z.string().describe('the task or message for the agent'),
      title: z.string().optional().describe('short run title (defaults to the prompt head)'),
      sessionId: z.string().optional().describe('existing session to continue'),
    },
    async (args) => {
      const client = await getClient()
      const prompt = args.prompt as string
      const input: SubTask = {
        profile: args.agent as string,
        prompt,
        title: (args.title as string | undefined) ?? prompt.slice(0, 60),
      }
      if (args.sessionId) input.sessionId = args.sessionId as string
      const res = await client.createRun(input)
      return jsonResult({ ...res, next: 'call wait_for_run with this runId to follow the run' })
    },
  )

  tool(
    'get_run',
    'Fetch a run: status plus its buffered events (cheap poll; use wait_for_run to block until new events or completion).',
    { runId: z.string() },
    async (args) => {
      const client = await getClient()
      const run = await client.getRun(args.runId as string)
      const { events, dropped } = capEvents(run.events ?? [])
      return jsonResult({
        ...run,
        events,
        ...(dropped > 0 ? { eventsDropped: dropped } : {}),
      })
    },
  )

  tool(
    'wait_for_run',
    'Long-poll a run: blocks until it finishes or timeoutSeconds elapses, returning events after afterEvent. Loop with nextAfterEvent until done is true.',
    {
      runId: z.string(),
      timeoutSeconds: z.number().int().min(1).max(240).optional().describe('max wait (default 60)'),
      afterEvent: z.number().int().min(0).optional().describe('skip this many already-seen events'),
    },
    async (args) => {
      const client = await getClient()
      const runId = args.runId as string
      const timeoutMs = (((args.timeoutSeconds as number) ?? 60) * 1000) | 0
      const skip = (args.afterEvent as number) ?? 0

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let seen = 0
      const fresh: RunEvent[] = []
      let status: string
      try {
        // streamRunEvents replays the buffer then follows live, returning
        // the terminal status, or 'running' when we abort on timeout.
        status = await streamRunEvents(
          client,
          runId,
          (event) => {
            seen++
            if (seen > skip) fresh.push(event)
          },
          { signal: controller.signal },
        )
      } finally {
        clearTimeout(timer)
      }
      const { events, dropped } = capEvents(fresh)
      return jsonResult({
        runId,
        status,
        done: status !== 'running',
        events,
        ...(dropped > 0 ? { eventsDropped: dropped } : {}),
        nextAfterEvent: seen,
      })
    },
  )

  tool(
    'list_runs',
    'List recent runs, optionally scoped to one agent or one session.',
    {
      agent: z.string().optional().describe('filter: agent profile name'),
      sessionId: z.string().optional().describe('filter: session id'),
      limit: z.number().int().min(1).max(200).optional().describe('max rows (default 20)'),
    },
    async (args) => {
      const client = await getClient()
      const limit = (args.limit as number) ?? 20
      const page = args.sessionId
        ? await client.listSessionRuns(args.sessionId as string, { limit })
        : args.agent
          ? await client.listProfileRuns(args.agent as string, { limit })
          : await client.listRuns({ limit })
      return jsonResult({ runs: page.items, total: page.total })
    },
  )

  tool('cancel_run', 'Cancel a running run.', { runId: z.string() }, async (args) => {
    const client = await getClient()
    await client.cancelRun(args.runId as string)
    return jsonResult({ runId: args.runId, cancelled: true })
  })

  // -- Skills ---------------------------------------------------------------------

  tool(
    'list_skills',
    'List the skills available in this tenant (attachable to agents).',
    { limit: z.number().int().min(1).max(200).optional() },
    async (args) => {
      const client = await getClient()
      const { items, total } = await client.listSkills({ limit: (args.limit as number) ?? 50 })
      return jsonResult({ skills: items, total })
    },
  )

  tool(
    'attach_skill',
    'Attach a skill to an agent profile.',
    { agent: z.string(), skill: z.string() },
    async (args) => {
      const client = await getClient()
      await client.request<void>(
        `/api/profiles/${encodeURIComponent(args.agent as string)}/skills/${encodeURIComponent(args.skill as string)}`,
        { method: 'PUT' },
      )
      return jsonResult({ agent: args.agent, skill: args.skill, attached: true })
    },
  )

  tool(
    'detach_skill',
    'Detach a skill from an agent profile.',
    { agent: z.string(), skill: z.string() },
    async (args) => {
      const client = await getClient()
      await client.request<void>(
        `/api/profiles/${encodeURIComponent(args.agent as string)}/skills/${encodeURIComponent(args.skill as string)}`,
        { method: 'DELETE' },
      )
      return jsonResult({ agent: args.agent, skill: args.skill, detached: true })
    },
  )

  // -- Storage ----------------------------------------------------------------------

  tool(
    'storage_list',
    'List objects in the tenant storage (VFS), optionally under a prefix.',
    {
      prefix: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional().describe('max rows (default 100)'),
    },
    async (args) => {
      const client = await getClient()
      const sp = new URLSearchParams()
      if (args.prefix) sp.set('prefix', args.prefix as string)
      if (args.limit != null) sp.set('limit', String(args.limit))
      const qs = sp.toString()
      return jsonResult(await client.request(`/api/storage/objects${qs ? `?${qs}` : ''}`))
    },
  )

  tool(
    'storage_read',
    'Read one storage object. Text comes back inline; binary comes back base64. Large objects are truncated at maxBytes.',
    {
      key: z.string(),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_BYTES)
        .optional()
        .describe(`cap on returned content bytes (default ${DEFAULT_STORAGE_READ_BYTES})`),
    },
    async (args) => {
      const client = await getClient()
      const obj = await client.request<{
        key: string
        contentType?: string
        size: number
        encoding: string
        content: string
      }>(`/api/storage/objects/${encodeStorageKey(args.key as string)}`)
      const cap = (args.maxBytes as number) ?? DEFAULT_STORAGE_READ_BYTES
      let content = obj.content
      let truncated = false
      if (content.length > cap) {
        content = content.slice(0, cap)
        truncated = true
      }
      return jsonResult({ ...obj, content, ...(truncated ? { truncatedAt: cap } : {}) })
    },
  )

  tool(
    'storage_write',
    'Write (upsert) one storage object. Pass base64: true when content is base64-encoded binary.',
    {
      key: z.string().describe('object key; must not end with "/"'),
      content: z.string(),
      contentType: z.string().optional().describe('stored Content-Type (default text/plain)'),
      base64: z.boolean().optional().describe('content is base64-encoded binary'),
    },
    async (args) => {
      const client = await getClient()
      const key = args.key as string
      if (key.endsWith('/')) {
        return errorResult('key must not end with "/" (that denotes a prefix)')
      }
      const body = args.base64
        ? Buffer.from(args.content as string, 'base64')
        : Buffer.from(args.content as string, 'utf8')
      const result = await client.request(`/api/storage/objects/${encodeStorageKey(key)}`, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': (args.contentType as string) ?? 'text/plain; charset=utf-8' },
      })
      return jsonResult(result)
    },
  )

  // -- Publishing ----------------------------------------------------------------------

  tool(
    'publish_agent',
    'Publish an agent as a public chat endpoint. options maps to the publish request body (visibility, authMode, allowedOrigins, ...; schema in orca://openapi).',
    {
      agent: z.string(),
      options: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      const client = await getClient()
      return jsonResult(
        await client.request(
          `/api/profiles/${encodeURIComponent(args.agent as string)}/publish`,
          { method: 'POST', body: JSON.stringify((args.options as object) ?? {}) },
        ),
      )
    },
  )

  // -- Escape hatch ----------------------------------------------------------------------

  tool(
    'api_request',
    'Escape hatch for any Orca API operation not covered by a dedicated tool: raw authenticated request against /api/*. The full OpenAPI spec is in the orca://openapi resource (or GET {apiUrl}/api/openapi.yaml).',
    {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().describe('request path; must start with /api/'),
      query: z.record(z.string(), z.string()).optional().describe('query string parameters'),
      body: z.unknown().optional().describe('JSON request body'),
    },
    async (args) => {
      const client = await getClient()
      const path = args.path as string
      if (!path.startsWith('/api/')) {
        return errorResult('path must start with /api/')
      }
      const sp = new URLSearchParams((args.query as Record<string, string>) ?? {})
      const qs = sp.toString()
      const full = `${path}${qs ? (path.includes('?') ? '&' : '?') + qs : ''}`
      const init: RequestInit = { method: args.method as string }
      if (args.body !== undefined) init.body = JSON.stringify(args.body)
      const result = await client.request<unknown>(full, init)
      return jsonResult(result === undefined ? { ok: true } : result)
    },
  )

  // -- Resources ----------------------------------------------------------------------

  server.registerResource(
    'openapi',
    'orca://openapi',
    {
      title: 'Orca OpenAPI specification',
      description: 'The full control-plane API schema, for use with the api_request tool.',
      mimeType: 'application/yaml',
    },
    async (uri) => {
      const client = await getClient()
      const res = await fetch(client.url('/api/openapi.yaml'))
      const text = await res.text()
      return { contents: [{ uri: uri.href, mimeType: 'application/yaml', text }] }
    },
  )

  return server
}

// encodeStorageKey mirrors src/commands/storage.tsx: slashes stay literal
// path separators for the Go {key...} wildcard; each segment is encoded.
function encodeStorageKey(key: string): string {
  const isFolder = key.endsWith('/')
  const trimmed = isFolder ? key.slice(0, -1) : key
  const safe = trimmed.split('/').map(encodeURIComponent).join('/')
  return safe + (isFolder ? '/' : '')
}
