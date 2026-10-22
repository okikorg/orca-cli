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
//   Lists return summaries (a get tool has the whole item), and a result
//   over the cap is still valid JSON: see results.ts.
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
import { findArtifact, oneDestination, saveArtifact, saveNewestTurn } from '../lib/artifacts.js'
import { modelRows, withPayer } from '../lib/models.js'
import { findVault } from '../lib/names.js'
import {
  createSession,
  messageText,
  requestSleep,
  sessionCreateParams,
  sessionView,
  waitForSleep,
} from '../lib/sessions.js'
import { collectSkillFiles } from '../lib/skills.js'
import { prepareFiles, stageIntoSession, type FileSpec } from '../lib/staging.js'
import { uploadFile } from '../lib/transfer.js'
import { VERSION } from '../version.js'
import { agentSummary, fitResult, itemSummary, mapPage, sessionSummary } from './results.js'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

// jsonResult is the value as JSON within MAX_RESULT_BYTES, always valid;
// full says how to get a whole item when strings had to be shortened.
function jsonResult(value: unknown, full?: string): ToolResult {
  return { content: [{ type: 'text', text: fitResult(value, full) }] }
}

function errorResult(message: string, detail?: string[]): ToolResult {
  const text = [message, ...(detail ?? [])].join('\n')
  return { content: [{ type: 'text', text }], isError: true }
}

// clientSource resolves the CLI context on every call, so a new login or
// context switch applies to a running server. A missing key is reported
// per-call with the exact fix, not at startup, so registering the server
// before first login works.
// A tool marked anonymous (a kit's public review) needs only the server URL.
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

// replyText joins the assistant's messages in one turn, oldest first, each
// as written (line breaks kept).
async function replyText(v1: OpenAI, sessionId: string, turnId: string): Promise<string> {
  const items = (await v1.beta.agents.sessions.items.list(sessionId, { limit: 50, order: 'desc' })).data
  return items
    .filter((item) => item.type === 'message' && item.role === 'assistant' && item.turn_id === turnId)
    .reverse()
    .map(messageText)
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
    opts: { anonymous?: boolean; full?: string } = {},
  ): void => {
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>) => {
      let client: ApiClient
      try {
        client = await getClient({ anonymous: opts.anonymous })
      } catch (err) {
        return err instanceof CliError ? errorResult(err.message, err.detail) : errorResult(String(err))
      }
      try {
        return jsonResult(await handler(client, args ?? {}), opts.full)
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
  // A vault is an id or the name of exactly one, as --vault takes it.
  const vaultId = async (client: ApiClient, ref: unknown) => (await findVault(await client.v1(), ref as string)).id
  // Files on this machine to stage into a session's sandbox, as --file does.
  const files = z
    .array(
      z.object({
        path: z.string().describe('the file on this machine'),
        dest: z.string().optional().describe('where it goes in the sandbox (default /workspace/<its name>)'),
      }),
    )
    .optional()
    .describe('files on this machine to stage into the sandbox (implies sandbox; up to 16 MiB each, 64 MiB together)')
  const stagedFiles = (args: Record<string, unknown>) => prepareFiles((args.files as FileSpec[] | undefined) ?? [])
  // Where a new session runs and which credentials it may use, as
  // create_session and a new chat take them. A template or vault is an id or
  // the name of exactly one.
  const sessionFields = {
    sandbox: z.boolean().optional().describe('run in a hosted sandbox (default: no environment)'),
    template: z.string().optional().describe('environment template id or name, for a hosted sandbox built from it'),
    vaults: z.array(z.string()).optional().describe('vault ids or names whose credentials the session may use'),
  }
  const sessionFlags = (args: Record<string, unknown>, staged: readonly { local: string }[]) => ({
    sandbox: args.sandbox as boolean | undefined,
    template: args.template as string | undefined,
    vault: (args.vaults as string[] | undefined) ?? [],
    file: staged.map((f) => f.local),
  })

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
    'Revoke an API key.',
    { id: z.string().describe('key id') },
    async (client, args) => {
      await client.revokeKey(args.id as string)
      return { id: args.id, revoked: true }
    },
  )

  // -- Agents -------------------------------------------------------------------

  tool(
    'list_agents',
    'List the agents in this Orca organization, newest first, as summaries: id, name, model, tool types and created_at, no instructions. get_agent returns one agent in full. To talk to an agent, pass its name to chat; no list is needed first.',
    { limit, after },
    async (client, args) => mapPage(toPage(await (await client.v1()).beta.agents.list(page(args))), agentSummary),
    { full: 'get_agent returns one agent in full' },
  )

  tool(
    'get_agent',
    'Fetch one agent (model, instructions, tools, everything) by id or name.',
    { agent: z.string().describe('agent id or name') },
    async (client, args) => (await client.v1()).beta.agents.retrieve(await agentId(client, args.agent)),
    { full: 'the CLI prints the whole agent: orca agents get <agent> --json' },
  )

  tool(
    'create_agent',
    'Create an agent. spec is the POST /v1/agents body: model, name, instructions, tools, reasoning, multi_agent. The model says who pays: orca/openrouter/<OpenRouter id> runs on Orca credit (such as orca/openrouter/openai/gpt-5.6-luna), <provider>/<id> on the organization\'s own key for openai, anthropic, openrouter, vercel or cheaperinference (such as anthropic/claude-sonnet-4-5). A bare name is refused.',
    { spec: z.record(z.string(), z.unknown()).describe('the agent body; model is required') },
    async (client, args) => (await client.v1()).beta.agents.create(args.spec as unknown as AgentCreateParams),
  )

  tool(
    'update_agent',
    'Update an agent. spec holds only the fields to change; the rest are kept. A model names who pays, as in create_agent.',
    {
      agent: z.string().describe('agent id or name'),
      spec: z.record(z.string(), z.unknown()).describe('fields to change'),
    },
    async (client, args) =>
      (await client.v1()).beta.agents.update(await agentId(client, args.agent), args.spec as AgentUpdateParams),
  )

  tool(
    'list_models',
    'List the model names an agent can use, one row each: id, payer (orca for Orca credit, else the provider whose saved key pays) and, for Orca credit, OpenRouter\'s price per million tokens in micro-USD and plan: free for one of Orca\'s free models (no charge, on every plan with a free-model share; none are listed while they are off); every other Orca credit model runs on credit on every plan, Free included. Orca credit pays the price plus OpenRouter\'s fee (openrouter_fee_bps). The list is long: narrow it with query (part of the name, such as luna or claude) or payer, and page with limit and after. Use an id as an agent\'s model.',
    {
      payer: z.string().optional().describe('orca, or a provider such as anthropic'),
      query: z.string().optional().describe('only names containing this, in any case'),
      limit,
      after: z.string().optional().describe('cursor: the last id of the previous page'),
    },
    async (client, args) => {
      const list = withPayer(await client.models(), args.payer as string | undefined)
      const rows = modelRows(list, args.query as string | undefined)
      const start = args.after ? rows.findIndex((row) => row.id === args.after) + 1 : 0
      if (args.after && start === 0) throw new CliError(`unknown cursor ${String(args.after)}`, ExitCode.Usage)
      const items = rows.slice(start, start + ((args.limit as number | undefined) ?? 20))
      const unavailable = list.groups.filter((g) => !g.available).map((g) => g.label)
      return {
        openrouter_fee_bps: list.openrouter_fee_bps,
        items,
        hasMore: start + items.length < rows.length,
        lastId: items.at(-1)?.id ?? null,
        ...(unavailable.length ? { unavailable } : {}),
      }
    },
  )

  tool('delete_agent', 'Delete an agent.', { agent: z.string().describe('agent id or name') }, async (client, args) =>
    (await client.v1()).beta.agents.delete(await agentId(client, args.agent)),
  )

  // -- Sessions and chat ----------------------------------------------------------

  tool(
    'list_sessions',
    'List sessions (conversations), newest first, optionally of one agent, as summaries: id, status, agent (id, name, model), environment type, created_at, last_active_at and any error. get_session returns one in full.',
    { agent: z.string().optional().describe('agent id or name'), limit, after },
    async (client, args) => {
      const filter = args.agent ? { agent_id: await agentId(client, args.agent) } : {}
      return mapPage(toPage(await (await client.v1()).beta.agents.sessions.list({ ...page(args), ...filter })), sessionSummary)
    },
    { full: 'get_session returns one session in full' },
  )

  tool(
    'get_session',
    'Fetch one session: status, environment, error; model (what its next turn runs on), agent_model and payer (orca_credit or own_key); sandbox (none, awake, going_to_sleep, asleep or waking) and last_sleep (its newest sleep: reason, outcome and the server\'s message, such as a workspace discarded or near the size Free keeps); and usage: its all-time usage summary by model with cost in micro-USD.',
    { id: z.string() },
    async (client, args) => sessionView(client, args.id as string),
  )

  tool(
    'create_session',
    'Create a session of an agent without sending anything. Use chat to talk to it, or pass the same fields to chat to create and send in one call. template and vaults take ids or names. files stages files on this machine into its sandbox.',
    {
      agent: z.string().describe('agent id or name'),
      ...sessionFields,
      files,
    },
    async (client, args) => {
      const staged = await stagedFiles(args)
      return createSession(await client.v1(), await agentId(client, args.agent), sessionFlags(args, staged), staged)
    },
  )

  tool(
    'list_session_items',
    'Read a session\'s conversation items, newest first: each message with its whole text, and each tool call with arguments and output over 2000 characters shortened. Page to older items with after.',
    { id: z.string(), limit, after: z.string().optional().describe('cursor: the last id of the previous page (older items follow)') },
    async (client, args) => {
      const list = await (await client.v1()).beta.agents.sessions.items.list(args.id as string, { ...page(args), order: 'desc' })
      const items = list.data.map(itemSummary)
      const lastId = [...items].reverse().find((item) => typeof item.id === 'string')?.id ?? null
      return { items, hasMore: Boolean(list.has_more), lastId }
    },
  )

  tool(
    'list_artifacts',
    'List a session\'s artifacts, newest first: the files its turns saved under /workspace/outputs, kept when each turn completes. Each has id, path, size_bytes and turn_id.',
    { session: z.string(), limit, after },
    async (client, args) =>
      toPage(await (await client.v1()).beta.agents.sessions.artifacts.list(args.session as string, page(args))),
  )

  tool(
    'download_artifact',
    'Download a session\'s artifacts to this machine. Pass artifact (an id, or a path as list_artifacts shows it) to save one to path, a file, or a folder to save it in under its own name; or all: true to save every artifact of the newest turn into the folder path. A file name never leaves the folder.',
    {
      session: z.string(),
      artifact: z.string().optional().describe('artifact id, or its path in the sandbox'),
      all: z.boolean().optional().describe('every artifact of the newest turn'),
      path: z.string().describe('where to save: a file or folder for one artifact, a folder for all'),
    },
    async (client, args) => {
      const v1 = await client.v1()
      const sessionId = args.session as string
      const target = args.path as string
      if (Boolean(args.all) === (args.artifact !== undefined)) {
        throw new CliError('pass artifact, or all: true', ExitCode.Usage)
      }
      if (args.all) return saveNewestTurn(v1, sessionId, target)
      const artifact = await findArtifact(v1, sessionId, args.artifact as string)
      return saveArtifact(v1, artifact, await oneDestination(artifact, target))
    },
  )

  // Waits less than the CLI's 10 minutes: an MCP call is request and
  // response, and the sleep goes on after the tool returns. The last poll
  // starts by 55 seconds in, so the answer lands inside the 60-second request
  // timeout MCP clients default to.
  tool(
    'sleep_session',
    'Put a session\'s sandbox to sleep now. Files in /workspace are saved and machine time stops; the conversation stays, and the next message wakes it. Running programs stop and do not come back. Refused while a turn runs. Waits up to 60 seconds and returns state and last_sleep.',
    { id: z.string() },
    async (client, args) => {
      const id = args.id as string
      const deadline = Date.now() + 55_000
      return waitForSleep(client, id, await requestSleep(client, id), deadline)
    },
  )

  tool('delete_session', 'Delete a session and its history.', { id: z.string() }, async (client, args) =>
    (await client.v1()).beta.agents.sessions.delete(args.id as string),
  )

  tool(
    'chat',
    'Send a message to an agent and wait for its reply. agent is an id or a name: pass the name the user gave as it is, with no list_agents or get_agent call first. Pass session to continue a conversation, otherwise agent starts a new session. For a new session, sandbox, template and vaults say where it runs and which credentials it may use, as in create_session: template and vaults take ids or names, so a kit that needs them (its README names them, such as vaults: ["dataforseo"]) starts with this one call. files stages files on this machine into the sandbox first (a new session gets one; a session continued must have one). Returns the reply and the session id; if the turn outlasts timeoutSeconds, done is false: the turn is still running, so never send the message again; poll get_session until its status is idle, then read the reply with list_session_items. Files the agent saves under /workspace/outputs come back with list_artifacts and download_artifact.',
    {
      message: z.string().describe('the message for the agent'),
      agent: z.string().optional().describe('agent id or name (a name needs no lookup first), for a new session'),
      session: z.string().optional().describe('existing session to continue'),
      ...sessionFields,
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe('max wait (default 120)'),
      files,
    },
    async (client, args) => {
      const v1 = await client.v1()
      const message = args.message as string
      const deadline = Date.now() + ((args.timeoutSeconds as number | undefined) ?? 120) * 1000
      const staged = await stagedFiles(args)
      let sessionId = args.session as string | undefined
      let previous: string | null = null
      const environment =
        Boolean(args.sandbox) || args.template !== undefined || ((args.vaults as string[] | undefined) ?? []).length > 0
      if (sessionId && environment) {
        throw new CliError('sandbox, template and vaults are for a new session; a session continued keeps its own', ExitCode.Usage, [
          'Drop them to continue this session, or drop session to start a new one.',
        ])
      }
      if (!sessionId && (staged.length || environment)) {
        // A new session with files, a sandbox, a template or vaults: created
        // first, as create_session does, so the message goes to a session
        // that has them (a template's files are staged after the create).
        if (!args.agent) throw new CliError('pass agent for a new session, or session to continue one', ExitCode.Usage)
        sessionId = (await createSession(v1, await agentId(client, args.agent), sessionFlags(args, staged), staged)).id
      } else if (sessionId) {
        await stageIntoSession(v1, sessionId, staged)
      }
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
        if (!args.agent) throw new CliError('pass agent for a new session, or session to continue one', ExitCode.Usage)
        const session = await v1.beta.agents.sessions.create({
          ...sessionCreateParams(await agentId(client, args.agent), { vault: [] }),
          input: message,
        })
        sessionId = session.id
      }
      const turn = await waitForTurn(v1, sessionId, previous, deadline)
      if (!turn) {
        return {
          sessionId,
          done: false,
          next: 'the turn is still running; never send the message again. Poll get_session about every 30 s until its status is idle, then read the reply with list_session_items (newest first)',
        }
      }
      return {
        sessionId,
        done: true,
        status: turn.status,
        reply: await replyText(v1, sessionId, turn.id),
        ...(turn.error ? { error: turn.error } : {}),
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

  tool(
    'delete_vault',
    'Delete a vault and its credentials (admin).',
    { id: z.string().describe('vault id or name') },
    async (client, args) => (await client.v1()).beta.agents.vaults.delete(await vaultId(client, args.id)),
  )

  tool(
    'list_credentials',
    'List the credentials in a vault. Values are never returned.',
    { vault: z.string().describe('vault id or name'), limit, after },
    async (client, args) =>
      toPage(await (await client.v1()).beta.agents.vaults.credentials.list(await vaultId(client, args.vault), page(args))),
  )

  tool(
    'add_credential',
    'Add a credential for an MCP server to a vault (admin): type static_bearer (the default) sends token as a bearer token; static_basic sends login and password as HTTP Basic (such as DataForSEO\'s API login). It is sealed and never returned. Prefer the terminal: a secret passed here sits in your context. Ask the user to run orca vaults credentials add <vault> --name <name> --server <url> (with --basic --login <login> for a login and password) themselves, which reads the secret from a hidden prompt, and never ask them to paste a password into the chat.',
    {
      vault: z.string().describe('vault id or name'),
      name: z.string(),
      server: z.string().describe('the MCP server URL (https)'),
      type: z.enum(['static_bearer', 'static_basic']).optional().describe('static_bearer (default): token; static_basic: login and password'),
      token: z.string().optional().describe('the bearer token, for static_bearer'),
      login: z.string().optional().describe('the login, for static_basic'),
      password: z.string().optional().describe('the password, for static_basic'),
    },
    async (client, args) => {
      const name = args.name as string
      const server = args.server as string
      // The fields are checked before the vault is looked up, so a bad call
      // makes no request.
      if (args.type === 'static_basic') {
        if (args.token !== undefined) throw new CliError('token is for static_bearer; static_basic takes login and password', ExitCode.Usage)
        if (!args.login || !args.password) throw new CliError('static_basic needs login and password', ExitCode.Usage)
        const vault = await vaultId(client, args.vault)
        return client.createBasicCredential(vault, { name, server, login: args.login as string, password: args.password as string })
      }
      if (args.login !== undefined || args.password !== undefined) {
        throw new CliError('login and password are for type static_basic', ExitCode.Usage)
      }
      if (!args.token) throw new CliError('static_bearer needs token', ExitCode.Usage)
      return (await client.v1()).beta.agents.vaults.credentials.create(await vaultId(client, args.vault), {
        name,
        auth: { type: 'static_bearer', mcp_server_url: server, token: args.token as string },
      })
    },
  )

  tool(
    'delete_credential',
    'Delete a credential (admin).',
    { vault: z.string().describe('vault id or name'), id: z.string().describe('credential id') },
    async (client, args) =>
      (await client.v1()).beta.agents.vaults.credentials.delete(args.id as string, { vault_id: await vaultId(client, args.vault) }),
  )

  // -- Files ----------------------------------------------------------------------

  tool('list_files', 'List uploaded files, newest first.', { limit, after }, async (client, args) =>
    toPage(await (await client.v1()).files.list(page(args))),
  )

  tool(
    'upload_file',
    'Upload a file on this machine.',
    { path: z.string(), name: z.string().optional().describe('store it under this name') },
    async (client, args) => uploadFile(await client.v1(), args.path as string, args.name as string | undefined),
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
    'Usage totals per meter with their cost in micro-USD, a series bucketed by the UTC hour (windows up to 2 days) or the UTC day (up to 366 days; null beyond), with every bucket and meter, and optional groups. daily is deprecated and goes on or after 2027-01-11. With groupBy, group_costs gives each key\'s cost across every meter (a model\'s, session\'s or agent\'s cost); a call\'s money is on its model_calls row, not its token rows. Costs are the server\'s; do not recompute them.',
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
    'Raw usage rows, newest first, each with its cost in micro-USD. charged_on says where a row\'s money is when another row carries it (call, search, or late: charged later on a late_charges row). A late_charges row carries the whole cost of a call whose cost was not reported when it ended; its charge_for names the row it charges (<attempt>:call or <attempt>:search). charged: true returns only the rows with a cost.',
    { meter: z.string().optional(), charged: z.boolean().optional(), limit, after },
    async (client, args) =>
      client.usageEvents({ ...page(args), meter: args.meter as string | undefined, charged: args.charged as boolean | undefined }),
  )

  tool(
    'get_wallet',
    'The credit wallet: balance, credited and charged (micro-USD), plan tier, period, compute allowance (included_compute_seconds, used_compute_seconds), and the credit packs on sale. granted_credit_micro_usd is credit Orca granted, spent first, and paid_credit_micro_usd the rest, which never expires; granted_credit lists each grant with left_micro_usd and expires_at (00:00 UTC the day after its last day); expired_micro_usd is granted credit that expired unspent. free_model_today is calls_today of calls_per_day, the free model\'s share today, on every plan with a share (null on a plan with none; free_model is the plan facts\' list of free models, empty while they are off). On the Free plan: network (off is true while Free sandboxes have no network, with the message to show; once the organization has credit, off is false, with sandboxes_without_network and a message while running sandboxes that started without it remain), credit_request (where to ask for credit, with its message), and included_hours_withheld (true when Free\'s included machine time and free model are not available for this organization).',
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

  tool(
    'show_kit',
    'Read the review of one of Orca\'s kits by its public id (kit-...), as orca kits show prints it: its version, what it runs, reaches and spends, every agent with its instructions and tools, every skill and template with its files and setup commands, and the credentials a copy needs. Show it to the person before copy_kit.',
    { publicId: z.string() },
    async (client, args) => client.kitReview(args.publicId as string),
    { anonymous: true, full: 'the CLI prints the whole review: orca kits show <link> --json' },
  )

  tool(
    'copy_kit',
    'Copy one of Orca\'s kits into this organization, at the version show_kit returned. Show the person the review from show_kit first, and copy only after they say yes.',
    {
      publicId: z.string(),
      version: z.number().int().min(1).describe('the version show_kit returned; a newer one fails with kit_changed and copies nothing'),
      assets: z
        .array(z.object({ key: z.string(), name: z.string() }))
        .describe('{key, name} for each asset to copy (keys from show_kit); a name already in use fails the whole copy with name_taken'),
    },
    async (client, args) =>
      client.copyKit(args.publicId as string, args.version as number, args.assets as { key: string; name: string }[]),
  )

  return server
}
