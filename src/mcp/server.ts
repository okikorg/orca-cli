// Orca's MCP server (stdio), mounted by `orca mcp serve`.
//
// This is how coding agents (Claude Code, Cursor, Codex) drive Orca without
// shelling out per call: one tool per CLI action, over the same /api routes
// and /v1 Agents API the commands use. The commands that only touch this
// machine (auth login and logout, context, doctor, update) have no tool.
//
// Design rules:
// - stdio discipline: nothing but JSON-RPC on stdout. Every tool failure is
//   an in-band MCP error result (isError: true) whose text contains the fix,
//   because agents act on error text. The process never mounts Ink.
// - context economy: compact JSON, capped byte sizes, described truncation.
//   MCP tools are request/response, so `chat` waits for the turn up to a
//   timeout and says how to pick it up when it runs longer.
// - auth is the CLI's own: flag > ORCA_API_KEY > ~/.config/orca contexts,
//   resolved lazily so `claude mcp add` can register the server before the
//   user has logged in.
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type OpenAI from 'openai'
import type { AgentCreateParams, AgentUpdateParams } from 'openai/resources/beta/agents/agents'
import type { Turn } from 'openai/resources/beta/agents/sessions/turns'
import { z } from 'zod'

import { resolveAgentId } from '../lib/agents.js'
import { ApiClient, mapApiError, toPage } from '../lib/api.js'
import { resolveContext, type GlobalFlags } from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { itemText, publishedScope, sessionAgent, sessionCreateParams } from '../lib/sessions.js'
import { collectSkillFiles } from '../lib/skills.js'
import type { KitInput } from '../lib/types.js'
import { VERSION } from '../version.js'

// Result payloads are capped so one tool call cannot flood an agent's
// context window. Truncation is always announced in the payload.
const MAX_RESULT_BYTES = 50_000

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function jsonResult(value: unknown): ToolResult {
  let text = JSON.stringify(value, null, 1)
  if (text.length > MAX_RESULT_BYTES) {
    text =
      text.slice(0, MAX_RESULT_BYTES) +
      `\n... [truncated at ${MAX_RESULT_BYTES} bytes; narrow the request (limit, after) for the rest]`
  }
  return { content: [{ type: 'text', text }] }
}

function errorResult(message: string, detail?: string[]): ToolResult {
  const text = [message, ...(detail ?? [])].join('\n')
  return { content: [{ type: 'text', text }], isError: true }
}

// clientSource resolves the CLI context on every call, so a new login or
// context switch applies to a running server. A missing key is reported
// per-call with the exact fix, not at startup, so registering the server
// before first login works.
// A tool marked anonymous (a public kit page) needs only the server URL.
export type ClientSource = (opts?: { anonymous?: boolean }) => Promise<ApiClient>

export function makeClientSource(flags: GlobalFlags): ClientSource {
  return async (opts) => {
    const ctx = await resolveContext(flags)
    if (opts?.anonymous && ctx.apiUrl) {
      return new ApiClient({ apiUrl: ctx.apiUrl.replace(/\/+$/, ''), apiKey: ctx.apiKey ?? '', contextName: ctx.name })
    }
    if (!ctx.apiUrl || !ctx.apiKey) {
      throw new CliError('not logged in to Orca.', ExitCode.Auth, [
        'Run: orca auth login   (or set ORCA_API_KEY and ORCA_API_URL)',
      ])
    }
    return new ApiClient({
      apiUrl: ctx.apiUrl.replace(/\/+$/, ''),
      apiKey: ctx.apiKey,
      contextName: ctx.name,
      dashboardUrl: ctx.dashboardUrl,
    })
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const TERMINAL = new Set<Turn['status']>(['completed', 'failed', 'cancelled'])

// waitForTurn polls a session's newest turn until it is a new one (not
// `previous`) and has ended, or the deadline passes.
async function waitForTurn(
  v1: OpenAI,
  sessionId: string,
  previous: string | null,
  deadline: number,
): Promise<Turn | null> {
  while (Date.now() < deadline) {
    const [turn] = (await v1.beta.agents.sessions.turns.list(sessionId, { limit: 1 })).data
    if (turn && turn.id !== previous && TERMINAL.has(turn.status)) return turn
    await sleep(500)
  }
  return null
}

// replyText joins the assistant's messages in one turn, oldest first.
async function replyText(v1: OpenAI, sessionId: string, turnId: string): Promise<string> {
  const items = (await v1.beta.agents.sessions.items.list(sessionId, { limit: 50, order: 'desc' })).data
  return items
    .filter((item) => item.type === 'message' && item.role === 'assistant' && item.turn_id === turnId)
    .reverse()
    .map(itemText)
    .join('\n\n')
}

const limit = z.number().int().min(1).max(100).optional().describe('max rows (default 20)')
const after = z.string().optional().describe('cursor: the last id of the previous page')

// buildMcpServer wires every tool onto a fresh McpServer. Exported for tests
// (driven over an in-memory transport).
export function buildMcpServer(getClient: ClientSource): McpServer {
  const server = new McpServer({ name: 'orca', version: VERSION })

  // tool wraps a handler with the client lookup and the shared error mapping.
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (client: ApiClient, args: Record<string, unknown>) => Promise<unknown>,
    opts: { anonymous?: boolean } = {},
  ): void => {
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>) => {
      let client: ApiClient
      try {
        client = await getClient(opts)
      } catch (err) {
        return err instanceof CliError ? errorResult(err.message, err.detail) : errorResult(String(err))
      }
      try {
        return jsonResult(await handler(client, args ?? {}))
      } catch (err) {
        const mapped = mapApiError(err, client)
        return errorResult(mapped.message, mapped.detail)
      }
    })
  }
  const page = (args: Record<string, unknown>) => ({
    limit: (args.limit as number | undefined) ?? 20,
    ...(args.after ? { after: args.after as string } : {}),
  })
  const agentId = async (client: ApiClient, ref: unknown) => resolveAgentId(await client.v1(), ref as string)

  // -- Identity and keys ------------------------------------------------------

  tool(
    'whoami',
    'Identify the authenticated Orca caller: tenant, actor, role. Call this first to confirm auth works.',
    {},
    async (client) => ({ ...(await client.whoami()), apiUrl: client.apiUrl, context: client.contextName }),
  )

  tool('list_keys', 'List active API keys, newest first. Never shows secrets.', { limit, after }, async (client, args) =>
    client.listKeys(page(args)),
  )

  tool(
    'create_key',
    'Mint an API key with the caller\'s role. The secret is in this one response and cannot be read again.',
    { name: z.string().describe('a name for the key') },
    async (client, args) => client.createKey(args.name as string),
  )

  tool(
    'revoke_key',
    'Revoke an API key. Revoking a published agent\'s last scoped key unpublishes the agent.',
    { id: z.string().describe('key id') },
    async (client, args) => {
      await client.revokeKey(args.id as string)
      return { id: args.id, revoked: true }
    },
  )

  // -- Agents -------------------------------------------------------------------

  tool('list_agents', 'List the agents in this Orca organization, newest first.', { limit, after }, async (client, args) =>
    toPage(await (await client.v1()).beta.agents.list(page(args))),
  )

  tool(
    'get_agent',
    'Fetch one agent (model, instructions, tools, everything) by id or name.',
    { agent: z.string().describe('agent id or name') },
    async (client, args) => (await client.v1()).beta.agents.retrieve(await agentId(client, args.agent)),
  )

  tool(
    'create_agent',
    'Create an agent. spec is the POST /v1/agents body: model (with a provider prefix, such as openai/gpt-5), name, instructions, tools, reasoning, multi_agent.',
    { spec: z.record(z.string(), z.unknown()).describe('the agent body; model is required') },
    async (client, args) => (await client.v1()).beta.agents.create(args.spec as unknown as AgentCreateParams),
  )

  tool(
    'update_agent',
    'Update an agent. spec holds only the fields to change; the rest are kept.',
    {
      agent: z.string().describe('agent id or name'),
      spec: z.record(z.string(), z.unknown()).describe('fields to change'),
    },
    async (client, args) =>
      (await client.v1()).beta.agents.update(await agentId(client, args.agent), args.spec as AgentUpdateParams),
  )

  tool('delete_agent', 'Delete an agent.', { agent: z.string().describe('agent id or name') }, async (client, args) =>
    (await client.v1()).beta.agents.delete(await agentId(client, args.agent)),
  )

  // -- Sessions and chat ----------------------------------------------------------

  tool(
    'list_sessions',
    'List sessions (conversations), newest first, optionally of one agent.',
    { agent: z.string().optional().describe('agent id or name'), limit, after },
    async (client, args) => {
      const filter = args.agent ? { agent_id: await agentId(client, args.agent) } : {}
      return toPage(await (await client.v1()).beta.agents.sessions.list({ ...page(args), ...filter }))
    },
  )

  tool('get_session', 'Fetch one session: status, environment, usage, error.', { id: z.string() }, async (client, args) =>
    (await client.v1()).beta.agents.sessions.retrieve(args.id as string),
  )

  tool(
    'create_session',
    'Create a session of an agent without sending anything. Use chat to talk to it.',
    {
      agent: z.string().describe('agent id or name'),
      sandbox: z.boolean().optional().describe('run in a hosted sandbox (default: no environment)'),
      template: z.string().optional().describe('environment template id for a hosted sandbox'),
      vaults: z.array(z.string()).optional().describe('vault ids the session may use'),
    },
    async (client, args) => {
      const scope = await publishedScope(client)
      const params = sessionCreateParams(await sessionAgent(client, args.agent as string, scope), {
        sandbox: args.sandbox as boolean | undefined,
        template: args.template as string | undefined,
        vault: (args.vaults as string[] | undefined) ?? [],
      }, scope)
      return (await client.v1()).beta.agents.sessions.create(params)
    },
  )

  tool(
    'list_session_items',
    'Read a session\'s latest conversation items (messages and tool calls), oldest first.',
    { id: z.string(), limit },
    async (client, args) => {
      const items = await (await client.v1()).beta.agents.sessions.items.list(args.id as string, {
        limit: (args.limit as number | undefined) ?? 20,
        order: 'desc',
      })
      return [...items.data].reverse()
    },
  )

  tool('delete_session', 'Delete a session and its history.', { id: z.string() }, async (client, args) =>
    (await client.v1()).beta.agents.sessions.delete(args.id as string),
  )

  tool(
    'chat',
    'Send a message to an agent and wait for its reply. Pass session to continue a conversation, otherwise agent starts a new session. Returns the reply and the session id; if the turn outlasts timeoutSeconds, done is false and the reply is read later with list_session_items.',
    {
      message: z.string().describe('the message for the agent'),
      agent: z.string().optional().describe('agent id or name, for a new session'),
      session: z.string().optional().describe('existing session to continue'),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe('max wait (default 120)'),
    },
    async (client, args) => {
      const v1 = await client.v1()
      const message = args.message as string
      const deadline = Date.now() + ((args.timeoutSeconds as number | undefined) ?? 120) * 1000
      let sessionId = args.session as string | undefined
      let previous: string | null = null
      if (sessionId) {
        previous = (await v1.beta.agents.sessions.turns.list(sessionId, { limit: 1 })).data[0]?.id ?? null
        await v1.beta.agents.sessions.events.create(sessionId, {
          events: [
            {
              type: 'agent.session.input.message',
              input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }],
            },
          ],
        })
      } else {
        const scope = await publishedScope(client)
        const ref = (args.agent as string | undefined) ?? scope?.agent
        if (!ref) throw new CliError('pass agent for a new session, or session to continue one', ExitCode.Usage)
        const session = await v1.beta.agents.sessions.create({
          ...sessionCreateParams(await sessionAgent(client, ref, scope), { vault: [] }, scope),
          input: message,
        })
        sessionId = session.id
      }
      const turn = await waitForTurn(v1, sessionId, previous, deadline)
      if (!turn) {
        return { sessionId, done: false, next: 'the turn is still running; read it later with list_session_items' }
      }
      return {
        sessionId,
        done: true,
        status: turn.status,
        reply: await replyText(v1, sessionId, turn.id),
        ...(turn.error ? { error: turn.error } : {}),
        usage: turn.usage,
      }
    },
  )

  // -- Skills ---------------------------------------------------------------------

  tool('list_skills', 'List skills, newest first.', { limit, after }, async (client, args) =>
    toPage(await (await client.v1()).skills.list(page(args))),
  )

  tool('get_skill', 'Fetch one skill\'s metadata.', { id: z.string() }, async (client, args) =>
    (await client.v1()).skills.retrieve(args.id as string),
  )

  tool(
    'create_skill',
    'Upload an Agent Skills folder on this machine (it must contain SKILL.md) as a new skill.',
    { path: z.string().describe('the folder\'s path') },
    async (client, args) => {
      const dir = path.resolve(args.path as string)
      const files = await collectSkillFiles(dir)
      if (!files.some((f) => f.relPath === 'SKILL.md')) {
        throw new CliError(`no SKILL.md in ${dir}`, ExitCode.Usage)
      }
      const { toFile } = await import('openai/uploads')
      const folder = path.basename(dir)
      const uploads = await Promise.all(files.map((f) => toFile(f.bytes, `${folder}/${f.relPath}`)))
      return (await client.v1()).skills.create({ files: uploads })
    },
  )

  tool('delete_skill', 'Delete a skill and all its versions.', { id: z.string() }, async (client, args) =>
    (await client.v1()).skills.delete(args.id as string),
  )

  // -- Vaults ---------------------------------------------------------------------

  tool('list_vaults', 'List vaults (they hold the credentials MCP tools use).', { limit, after }, async (client, args) =>
    toPage(await (await client.v1()).beta.agents.vaults.list(page(args))),
  )

  tool('create_vault', 'Create a vault (admin).', { name: z.string() }, async (client, args) =>
    (await client.v1()).beta.agents.vaults.create({ name: args.name as string }),
  )

  tool('delete_vault', 'Delete a vault and its credentials (admin).', { id: z.string() }, async (client, args) =>
    (await client.v1()).beta.agents.vaults.delete(args.id as string),
  )

  tool(
    'list_credentials',
    'List the credentials in a vault. Values are never returned.',
    { vault: z.string(), limit, after },
    async (client, args) =>
      toPage(await (await client.v1()).beta.agents.vaults.credentials.list(args.vault as string, page(args))),
  )

  tool(
    'add_credential',
    'Add a bearer token for an MCP server to a vault (admin). The token is sealed and never returned.',
    {
      vault: z.string(),
      name: z.string(),
      server: z.string().describe('the MCP server URL (https)'),
      token: z.string(),
    },
    async (client, args) =>
      (await client.v1()).beta.agents.vaults.credentials.create(args.vault as string, {
        name: args.name as string,
        auth: { type: 'static_bearer', mcp_server_url: args.server as string, token: args.token as string },
      }),
  )

  tool('delete_credential', 'Delete a credential (admin).', { vault: z.string(), id: z.string() }, async (client, args) =>
    (await client.v1()).beta.agents.vaults.credentials.delete(args.id as string, { vault_id: args.vault as string }),
  )

  // -- Files ----------------------------------------------------------------------

  tool('list_files', 'List uploaded files, newest first.', { limit, after }, async (client, args) =>
    toPage(await (await client.v1()).files.list(page(args))),
  )

  tool(
    'upload_file',
    'Upload a file on this machine.',
    { path: z.string(), name: z.string().optional().describe('store it under this name') },
    async (client, args) => {
      const target = args.path as string
      const { toFile } = await import('openai/uploads')
      const file = await toFile(await fs.readFile(target), (args.name as string | undefined) ?? path.basename(target))
      return (await client.v1()).files.create({ file, purpose: 'user_data' })
    },
  )

  tool(
    'download_file',
    'Download a file\'s bytes to a path on this machine.',
    { id: z.string(), path: z.string().describe('where to write it') },
    async (client, args) => {
      const res = await (await client.v1()).files.content(args.id as string)
      const bytes = Buffer.from(await res.arrayBuffer())
      await fs.writeFile(args.path as string, bytes)
      return { id: args.id, path: args.path, bytes: bytes.length }
    },
  )

  tool('delete_file', 'Delete a file.', { id: z.string() }, async (client, args) =>
    (await client.v1()).files.delete(args.id as string),
  )

  // -- Usage and billing ------------------------------------------------------------

  tool(
    'get_usage',
    'Usage totals per meter with their cost in micro-USD, a daily series, and optional groups. Costs are the server\'s; do not recompute them.',
    {
      days: z.number().int().min(1).max(366).optional().describe('look-back window (default 30)'),
      groupBy: z.enum(['model', 'provider', 'credential', 'session', 'agent']).optional(),
      session: z.string().optional().describe('only this session'),
    },
    async (client, args) => {
      const end = Math.floor(Date.now() / 1000) + 1
      const start = end - ((args.days as number | undefined) ?? 30) * 86_400
      return client.usage({
        start,
        end,
        group_by: args.groupBy as string | undefined,
        session: args.session as string | undefined,
      })
    },
  )

  tool(
    'list_usage_events',
    'Raw usage rows, newest first, each with its cost in micro-USD.',
    { meter: z.string().optional(), limit, after },
    async (client, args) => client.usageEvents({ ...page(args), meter: args.meter as string | undefined }),
  )

  tool(
    'get_wallet',
    'The credit wallet: balance, credited and charged (micro-USD), plan tier, period, compute allowance, and the credit packs on sale.',
    {},
    async (client) => client.wallet(),
  )

  tool(
    'billing_checkout',
    'Open a checkout (admin): offer is plan:pro, plan:max, or pack:<cents> from get_wallet. Returns the URL for the user to open.',
    { offer: z.string() },
    async (client, args) => client.checkout(args.offer as string),
  )

  tool(
    'billing_portal',
    'Open the billing portal (admin) to change or cancel the plan. Returns the URL for the user to open.',
    {},
    async (client) => client.portal(),
  )

  // -- Kits -------------------------------------------------------------------------

  const kitFields = {
    name: z.string().optional(),
    description: z.string().optional(),
    readme: z.string().optional().describe('markdown'),
    agents: z.array(z.string()).optional().describe('agent ids or names'),
    skills: z.array(z.string()).optional().describe('skill ids'),
    templates: z.array(z.string()).optional().describe('environment template ids'),
  }
  const kitInput = async (client: ApiClient, args: Record<string, unknown>): Promise<Partial<KitInput>> => {
    const selection =
      args.agents || args.skills || args.templates
        ? {
            selection: {
              agents: await Promise.all(((args.agents as string[] | undefined) ?? []).map((a) => agentId(client, a))),
              skills: (args.skills as string[] | undefined) ?? [],
              templates: (args.templates as string[] | undefined) ?? [],
            },
          }
        : {}
    return {
      ...(args.name !== undefined ? { name: args.name as string } : {}),
      ...(args.description !== undefined ? { description: args.description as string } : {}),
      ...(args.readme !== undefined ? { readme: args.readme as string } : {}),
      ...selection,
    }
  }

  tool('list_kits', 'List this organization\'s kits.', {}, async (client) => client.listKits())

  tool(
    'make_kit',
    'Make a kit from agents, skills, and environment templates. Publish it with publish_kit.',
    { ...kitFields, name: z.string() },
    async (client, args) => {
      const input = await kitInput(client, args)
      return client.createKit({ selection: {}, ...input, name: args.name as string })
    },
  )

  tool(
    'edit_kit',
    'Change a kit. Passing agents, skills, or templates replaces the whole selection.',
    { id: z.string().describe('kit id'), ...kitFields },
    async (client, args) => client.updateKit(args.id as string, await kitInput(client, args)),
  )

  tool('publish_kit', 'Publish a kit\'s current selection as its next version.', { id: z.string() }, async (client, args) =>
    client.publishKit(args.id as string),
  )

  tool('withdraw_kit', 'Withdraw a published kit.', { id: z.string() }, async (client, args) =>
    client.withdrawKit(args.id as string),
  )

  tool(
    'show_kit',
    'Read a published kit by its public id (kit-...): contents, each asset\'s key, and the credentials a copy needs.',
    { publicId: z.string() },
    async (client, args) => client.publicKit(args.publicId as string),
    { anonymous: true },
  )

  tool(
    'copy_kit',
    'Copy a published kit into this organization. assets lists {key, name} for each asset to copy (keys from show_kit). A name already in use fails the whole copy with name_taken.',
    {
      publicId: z.string(),
      assets: z.array(z.object({ key: z.string(), name: z.string() })),
    },
    async (client, args) => client.copyKit(args.publicId as string, args.assets as { key: string; name: string }[]),
  )

  // -- Publishing -------------------------------------------------------------------

  tool(
    'publish_agent',
    'Publish an agent (admin): mint an API key scoped to it. Its sessions run with the template and vaults given here, which the key holder cannot change. The secret is in this one response. Unpublish with revoke_key.',
    {
      agent: z.string().describe('agent id or name'),
      label: z.string().describe('where the key is used'),
      template: z.string().optional().describe('environment template its sessions run in (default: no environment)'),
      vaults: z.array(z.string()).optional().describe('vault ids its sessions may use'),
    },
    async (client, args) =>
      client.publishAgent(await agentId(client, args.agent), {
        label: args.label as string,
        template: args.template as string | undefined,
        vaults: (args.vaults as string[] | undefined) ?? [],
      }),
  )

  tool(
    'list_published_keys',
    'List the scoped keys an agent is published with.',
    { agent: z.string().describe('agent id or name') },
    async (client, args) => client.publishedKeys(await agentId(client, args.agent)),
  )

  return server
}
