// Running turns on a /v1 session, shared by `orca chat` and `orca sessions`.
//
// A turn is sent with the openai package's session stream helper, which
// subscribes to the session's events, submits the input, and yields every
// event until the turn ends and the session goes idle. This module folds
// those events into the few the terminal renders: text deltas and tool
// activity, then how the turn ended.

import type { Command } from 'commander'
import type OpenAI from 'openai'
import { APIConnectionError, APIError } from 'openai/error'
import type {
  AgentOutputItem,
  AgentSession,
  AgentSessionEvent,
  AgentSessionItem,
  EnvironmentParam,
} from 'openai/resources/beta/agents/agents'

import { ApiError, extractErrorBody, type ApiClient } from './api.js'
import { CliError, ExitCode } from './errors.js'
import { formatCount } from './format.js'
import { stripControlSequences } from './markdown.js'
import { usdMicro } from './money.js'
import { findTemplate, findVault } from './names.js'
import {
  deleteUploads,
  environmentFiles,
  parseFileFlag,
  prepareFiles,
  uploadStaged,
  writeToEnvironment,
  type StagedFile,
  type StagedUpload,
} from './staging.js'
import type { SandboxSleep, SandboxState, SessionModel, SessionSandbox, UsageSummary } from './types.js'
import { groupCost } from './usage.js'

// A tool line's status: running, done, failed, or stopped (cut off by the
// turn's cancellation or interruption, which is not a failure).
export type ChatToolStatus = 'running' | 'ok' | 'error' | 'stopped'

// A tool event carries a web search's query and, when it failed, the
// server's reason (model-billing, Web search, The item), both one line of
// remote text with control bytes stripped. Other tools carry neither. A
// notice is one of the server's session notices, as the line to show.
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name?: string; status: ChatToolStatus; query?: string; reason?: string }
  | { type: 'notice'; text: string }

// How a turn ended:
//   done    - the turn completed (message is the reply text)
//   error   - the turn or the session failed, or needs an action the CLI
//             cannot take (message says which)
//   dropped - the event stream closed before the turn ended
//   aborted - the caller's AbortSignal fired (Ctrl-C); the turn is cancelled
export type ChatTurnResult = {
  terminated: 'done' | 'error' | 'dropped' | 'aborted'
  message: string
  errorCode?: string
  // The error's param: with usage_limit_exceeded, `orca_credit` or
  // `provider_quota` says whose credit ran out, and Free's stops name
  // theirs (`included_hours`, `free_model_capacity`, free-plan D3.16).
  errorParam?: string
  // The session's model, read for a `model_not_in_plan` refusal: one of
  // Orca's free models there is a tier with no share (amendment A5).
  errorModel?: string
  // Whether the server lists a free model that can run, read for a
  // `free_model_unavailable` refusal: the switch goes to it (amendment A3
  // (3)); none listed means the free models are off (A5).
  errorFreeModel?: boolean
}

export type StreamTurnOptions = {
  signal: AbortSignal
  // Every raw session event, for --json NDJSON.
  onRaw?: (event: AgentSessionEvent) => void
  // Folded events, for rendering.
  onEvent?: (event: ChatEvent) => void
}

// toolName names an output item that is a tool call, or returns null for
// anything else (messages, reasoning).
function toolName(item: AgentOutputItem | AgentSessionItem): string | null {
  switch (item.type) {
    case 'function_call':
      return item.name
    case 'mcp_call':
      return `${item.server_label}__${item.name}`
    case 'web_search_call':
      return 'web_search'
    case 'command_execution':
      return 'shell'
    case 'message':
    case 'reasoning':
    case 'function_call_output':
    case 'agent_message':
      return null
    default:
      return item.type
  }
}

// oneLine renders remote text as one line of at most max characters.
function oneLine(text: string, max: number): string {
  const line = stripControlSequences(text).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line
}

// The server's session notices (orca-design free-plan D3.16), each
// {type, message, at}: machine time nearly used, a turn ended at the free
// model's calls or at Free's time limit, a sandbox started without network,
// a new sandbox after a discarded workspace, a saved workspace near the size
// Free keeps (amendment A6 (1), (2), (26)). None ends the turn.
const NOTICES = new Set([
  'orca.compute.warning',
  'orca.free_model.turn_limit',
  'orca.turn.time_limit',
  'orca.network.off',
  'orca.sandbox.discarded',
  'orca.sandbox.workspace_near_limit',
])

// noticeText is the line a notice shows: its message as one line, the
// network's after `network  off.` as every surface says it.
export function noticeText(event: { type: string; message?: unknown }): string | null {
  if (!NOTICES.has(event.type) || typeof event.message !== 'string' || !event.message.trim()) return null
  const message = oneLine(event.message, 500)
  return event.type === 'orca.network.off' ? `network  off. ${message}` : message
}

// webSearchQuery is what a web search searched for. The server sets the
// item's action from the start, so an in-progress or failed search has its
// query too; an older server sends action null, and then there is none.
export function webSearchQuery(item: AgentOutputItem | AgentSessionItem): string | undefined {
  if (item.type !== 'web_search_call') return undefined
  const action = item.action
  if (!action || action.type !== 'search') return undefined
  const query = action.query || (action.queries ?? []).filter(Boolean).join(', ')
  return query ? oneLine(query, 100) : undefined
}

// webSearchReason is why a web search failed: the message of the item's
// `error` {code, message}, an Orca addition to the contract written for the
// user. An older server sends no error.
export function webSearchReason(item: AgentOutputItem | AgentSessionItem): string | undefined {
  if (item.type !== 'web_search_call') return undefined
  const error = (item as { error?: { message?: unknown } | null }).error
  return typeof error?.message === 'string' && error.message.trim() ? oneLine(error.message, 300) : undefined
}

// toolStatus reads an item's status as a tool line's. The contract's
// statuses are in_progress, completed and incomplete; `failed` is a function
// or MCP call's, and an older server's for a failed web search. An
// incomplete item with an error failed (the server writes a failed web
// search so); without one it was stopped by the turn's cancellation or
// interruption. A status the CLI does not know returns null: the line keeps
// what it last showed rather than being called failed.
function toolStatus(item: AgentOutputItem | AgentSessionItem): ChatToolStatus | null {
  const status = 'status' in item ? (item.status as string | null) : null
  switch (status) {
    case 'completed':
      return 'ok'
    case 'in_progress':
      return 'running'
    case 'failed':
      return 'error'
    case 'incomplete': {
      const error = (item as { error?: unknown }).error
      return error !== undefined && error !== null ? 'error' : 'stopped'
    }
    default:
      return null
  }
}

// streamTurn sends one message to an idle session and follows its turn to
// the end. It never throws for a failed turn: that is a { terminated:
// 'error' } result, so the REPL stays alive. HTTP failures before the stream
// opens (bad key, unknown session, out of credit) do throw, as openai errors.
// On abort the turn is cancelled server-side too, so Ctrl-C stops the spend.
export async function streamTurn(
  client: OpenAI,
  sessionId: string,
  message: string,
  opts: StreamTurnOptions,
): Promise<ChatTurnResult> {
  const sessions = client.beta.agents.sessions
  const stream = sessions.stream(sessionId, { input: message })
  const onAbort = () => {
    stream.abort()
    void sessions.events
      .create(sessionId, { events: [{ type: 'agent.session.input.cancel' }] })
      .catch(() => {
        /* the turn may already be over */
      })
  }
  if (opts.signal.aborted) return { terminated: 'aborted', message: '' }
  opts.signal.addEventListener('abort', onAbort, { once: true })

  let accum = ''
  let lastItem: string | null = null
  // The coordinator's turn: subagents' turns stream on the same session and
  // are shown as tool activity, not as reply text.
  let followed: string | null = null
  let result: ChatTurnResult | null = null
  try {
    for await (const event of stream) {
      opts.onRaw?.(event)
      // The SDK's union does not list Orca's notices; they arrive as sent.
      const notice = noticeText(event as { type: string; message?: unknown })
      if (notice !== null) {
        opts.onEvent?.({ type: 'notice', text: notice })
        continue
      }
      switch (event.type) {
        case 'agent.session.turn.created':
          if (followed === null && event.turn.subagent_id === null) followed = event.turn_id
          break
        case 'agent.session.turn.output_text.delta':
          if (event.turn_id !== followed) break
          // A new message item (commentary, then the final answer) starts a
          // new paragraph rather than running into the previous one.
          if (lastItem !== null && lastItem !== event.item_id && accum) {
            accum += '\n\n'
            opts.onEvent?.({ type: 'delta', text: '\n\n' })
          }
          lastItem = event.item_id
          accum += event.delta
          opts.onEvent?.({ type: 'delta', text: event.delta })
          break
        case 'agent.session.turn.item.added':
        case 'agent.session.turn.item.done': {
          const item = event.item
          const name = toolName(item)
          const status = toolStatus(item)
          if (name !== null && item.id && status !== null) {
            const query = webSearchQuery(item)
            const reason = status === 'error' ? webSearchReason(item) : undefined
            opts.onEvent?.({
              type: 'tool',
              id: item.id,
              name,
              status,
              ...(query ? { query } : {}),
              ...(reason ? { reason } : {}),
            })
          }
          break
        }
        case 'agent.session.turn.completed':
          if (event.turn_id === followed) result = { terminated: 'done', message: accum }
          break
        case 'agent.session.turn.failed':
          if (event.turn_id === followed) {
            result = {
              terminated: 'error',
              message: event.turn.error?.message ?? 'the turn failed',
              errorCode: event.turn.error?.code ?? undefined,
              errorParam: (event.turn.error as { param?: string | null } | null)?.param ?? undefined,
            }
          }
          break
        case 'agent.session.turn.cancelled':
          if (event.turn_id === followed) result = { terminated: 'aborted', message: accum }
          break
        case 'agent.session.requires_action':
          // A function tool the caller must run: the CLI has none to offer.
          result = {
            terminated: 'error',
            message: 'the agent called a function tool that only its own client can run',
          }
          break
        case 'agent.session.failed':
          result = { terminated: 'error', message: event.session.error ?? 'the session failed' }
          break
      }
      if (result?.terminated === 'error') break
    }
  } catch (err) {
    if (opts.signal.aborted) return { terminated: 'aborted', message: accum }
    // The package raises a stream's `error` event as an APIError without a
    // status (unlike a connection failure, which has its own class).
    if (err instanceof APIError && err.status === undefined && !(err instanceof APIConnectionError)) {
      const detail = err.error as { message?: string; code?: string | null; param?: string | null } | undefined
      return {
        terminated: 'error',
        message: detail?.message ?? err.message,
        errorCode: detail?.code ?? undefined,
        errorParam: detail?.param ?? undefined,
      }
    }
    // A failure before any event is an HTTP rejection: let the caller map it.
    if (followed === null && accum === '') throw err
    return { terminated: 'dropped', message: accum }
  } finally {
    opts.signal.removeEventListener('abort', onAbort)
  }
  if (opts.signal.aborted) return { terminated: 'aborted', message: accum }
  return result ?? { terminated: 'dropped', message: accum }
}

// itemText renders one conversation item as a single line: a message's text,
// or the name of the tool a call used; a web search adds its query, and
// `failed` with the server's reason when it failed. Remote text, so control
// bytes are stripped before it reaches any sink.
export function itemText(item: AgentSessionItem): string {
  if (item.type === 'message' || item.type === 'agent_message') {
    const parts = (item.content as unknown as { text?: unknown }[])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
    return stripControlSequences(parts.join(' ').replace(/\s+/g, ' ').trim())
  }
  if (item.type === 'function_call_output') return 'tool result'
  const name = toolName(item)
  if (!name) return item.type
  const line = `tool ${stripControlSequences(name)}`
  if (item.type !== 'web_search_call') return line
  const query = webSearchQuery(item)
  const withQuery = query ? `${line} "${query}"` : line
  if (toolStatus(item) !== 'error') return withQuery
  const reason = webSearchReason(item)
  return reason ? `${withQuery} failed: ${reason}` : `${withQuery} failed`
}

// messageText returns a message item's text as written: its parts one per
// line, with line breaks and indentation kept, so a reply's tables, lists and
// code survive. itemText is the one-line form for a table row. Remote text,
// so control bytes are stripped (stripControlSequences keeps \n and \t);
// blank lines at the start and whitespace at the end are trimmed.
export function messageText(item: AgentSessionItem): string {
  if (item.type !== 'message' && item.type !== 'agent_message') return itemText(item)
  const parts = (item.content as unknown as { text?: unknown }[])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
  return stripControlSequences(parts.join('\n')).replace(/^\n+/, '').trimEnd()
}

export function itemRole(item: AgentSessionItem): string {
  if (item.type === 'message') return item.role
  if (item.type === 'agent_message') return 'subagent'
  return 'tool'
}

// -- Creating sessions ----------------------------------------------------------

export type SessionCreateFlags = { sandbox?: boolean; template?: string; vault: string[]; file?: string[] }

const repeat = (value: string, previous: string[]) => [...previous, value]

// addSessionCreateOptions attaches the options every session-creating command
// shares: where the session runs, which vaults it may use, and the files on
// this machine staged into its sandbox.
export function addSessionCreateOptions(cmd: Command): Command {
  return cmd
    .option('--sandbox', 'run in a hosted sandbox (default: no environment)')
    .option('--template <template>', 'run in a hosted sandbox built from this environment template (id or name)')
    .option(
      '--vault <vault>',
      'make a vault\'s credentials available to the session (id or name; repeatable)',
      repeat,
      [] as string[],
    )
    .option(
      '--file <path[:dest]>',
      'stage a file on this machine into the sandbox, at /workspace/<name> unless dest says (repeatable; implies --sandbox)',
      repeat,
      [] as string[],
    )
}

// sessionEnvironment maps the flags onto the session's environment: none by
// default, a hosted sandbox with --sandbox or --file, built from a template
// with --template. `files` go in a new sandbox's create body; a template's
// session gets them after it exists (see createSession).
export function sessionEnvironment(flags: SessionCreateFlags, files: readonly StagedUpload[] = []): EnvironmentParam {
  if (flags.template !== undefined) {
    if (!flags.template.trim()) throw new CliError('--template needs an id or a name', ExitCode.Usage)
    return { type: 'openai_hosted', environment_template_id: flags.template }
  }
  if (files.length) return { type: 'openai_hosted', files: environmentFiles(files) }
  if (flags.sandbox || flags.file?.length) return { type: 'openai_hosted' }
  return { type: 'none' }
}

// sessionCreateParams is the one session-create body every command sends.
export function sessionCreateParams(agentId: string, flags: SessionCreateFlags, files: readonly StagedUpload[] = []) {
  return {
    agent_id: agentId,
    environment: sessionEnvironment(flags, files),
    ...(flags.vault.length ? { vault_ids: flags.vault } : {}),
  }
}

// filesFromFlags reads and checks every --file before anything is sent.
export async function filesFromFlags(flags: SessionCreateFlags): Promise<StagedFile[]> {
  return prepareFiles(await Promise.all((flags.file ?? []).map(parseFileFlag)))
}

// resolveSessionRefs turns the template and vaults the flags name, each an
// id or the name of exactly one (names.ts), into ids.
export async function resolveSessionRefs(client: OpenAI, flags: SessionCreateFlags): Promise<SessionCreateFlags> {
  const template = flags.template?.trim() ? (await findTemplate(client, flags.template)).id : flags.template
  const vault: string[] = []
  for (const ref of flags.vault) vault.push((await findVault(client, ref)).id)
  return { ...flags, template, vault }
}

// createSession creates a session with the flags' environment and vaults,
// staging `files` into its sandbox: in the create body for a new sandbox,
// or after the create for a template's, since a create-time list would
// replace the template's own files. A template or vault named by its name
// is looked up first, so a wrong name uploads nothing. Files uploaded for a
// create that fails are deleted.
export async function createSession(
  client: OpenAI,
  agentId: string,
  named: SessionCreateFlags,
  files: readonly StagedFile[] = [],
): Promise<AgentSession> {
  const flags = await resolveSessionRefs(client, named)
  const uploads = await uploadStaged(client, files)
  const atCreate = flags.template === undefined
  let session: AgentSession
  try {
    session = await client.beta.agents.sessions.create(sessionCreateParams(agentId, flags, atCreate ? uploads : []))
  } catch (err) {
    await deleteUploads(client, uploads)
    throw err
  }
  if (!atCreate && uploads.length && session.environment.type === 'openai_hosted') {
    try {
      await writeToEnvironment(client, session.environment.id, uploads)
    } catch (err) {
      await deleteUploads(client, uploads)
      throw err
    }
  }
  return session
}

// SessionView is a session as the CLI shows it: the /v1 object without its
// own usage field, and `usage`, the session's all-time /api/usage summary by
// model (decision 0017); and from /api/sessions/{id}/model, the model its
// next turn uses, the agent's own, and who pays (model-billing D3.13): a
// switch is visible here, while the /v1 object keeps the agent's model.
// `sandbox` is where its sandbox is (sandbox-sleep D6.7), from
// /api/sessions/{id}/sandbox; absent when that read failed, as on a server
// without the route.
export type SessionView = Omit<AgentSession, 'usage'> & {
  usage: UsageSummary
  model: string
  agent_model: string
  payer: SessionModel['payer']
  sandbox?: SandboxState
  // The sandbox's newest sleep since it last woke, with the server's message
  // (a discarded or near-limit workspace, free-plan A6 (1), (26)), as
  // GET /api/sessions/{id}/sandbox gives it; present with `sandbox`.
  last_sleep?: SandboxSleep | null
}

// sessionView reads one session, its usage and its model from their one
// source each. `sessions get` and the MCP server's get_session both answer
// with it.
export async function sessionView(client: ApiClient, id: string): Promise<SessionView> {
  const session = await (await client.v1()).beta.agents.sessions.retrieve(id)
  const usage = await client.usage({ start: 0, session: id, group_by: 'model' })
  const model = await client.sessionModel(id)
  // The sandbox lines are extra: a failed read leaves them out, never the
  // session.
  const sandbox = await client.sessionSandbox(id).then(
    (view) => view,
    () => undefined,
  )
  // `usage` replaces the /v1 object's own field.
  return {
    ...session,
    usage,
    model: model.model,
    agent_model: model.agent_model,
    payer: model.payer,
    ...(sandbox ? { sandbox: sandbox.state, last_sleep: sandbox.last_sleep } : {}),
  }
}

// -- Sandbox sleep (sandbox-sleep D6.7) -----------------------------------------

const SANDBOX_STATE_WORDS: Record<SandboxState, string> = {
  none: 'none',
  awake: 'awake',
  going_to_sleep: 'going to sleep',
  asleep: 'asleep',
  waking: 'waking up',
}

// sandboxStateWords says a sandbox state in words; a state this CLI does not
// know yet is shown as the server sent it.
export function sandboxStateWords(state: string): string {
  return SANDBOX_STATE_WORDS[state as SandboxState] ?? state
}

// goingToSleep is true while a sleep has not ended: the server saves the
// files after it answers the request.
export function goingToSleep(view: SessionSandbox): boolean {
  return view.state === 'going_to_sleep' || (view.last_sleep !== null && view.last_sleep.outcome === null)
}

// requestSleep starts putting a session's sandbox to sleep. A refusal (a
// turn is running, or the sandbox is waking up) is the server's own message.
export async function requestSleep(client: ApiClient, id: string): Promise<SessionSandbox> {
  try {
    return await client.sleepSessionSandbox(id)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'conflict') {
      throw new CliError(extractErrorBody(err.body) || 'the sandbox cannot be put to sleep now', ExitCode.Failure)
    }
    throw err
  }
}

// waitForSleep reads the sandbox every second until its sleep has ended or
// the deadline passes, and returns the last view read. The sleep goes on
// on the server either way.
export async function waitForSleep(
  client: ApiClient,
  id: string,
  view: SessionSandbox,
  deadline: number,
): Promise<SessionSandbox> {
  while (goingToSleep(view) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    view = await client.sessionSandbox(id)
  }
  return view
}

// The words for the sleep reasons the design gives them (free-plan
// amendment A6 (4), (28)). Any other reason says nothing more than asleep.
const SLEEP_REASON_WORDS: Readonly<Record<string, string>> = {
  suspended: 'Work for this organization is suspended. Ask on Discord: https://discord.gg/btTYzdzvqq',
  network_on: 'The sandbox slept so that its next start has the network, now that your organization has credit.',
}

// sleepNote is what to say about a sandbox's last sleep: the server's
// message (a discarded workspace, or a Free workspace near its size, A6 (1),
// (26)), else its reason's words, else null.
export function sleepNote(view: Pick<SessionSandbox, 'last_sleep'>): string | null {
  const last = view.last_sleep
  if (!last) return null
  const note = last.message || SLEEP_REASON_WORDS[last.reason]
  return note ? oneLine(note, 500) : null
}

// sleepFailure is why a sleep that has ended left the sandbox awake (too
// large, failed, interrupted), or null when it did not.
export function sleepFailure(view: SessionSandbox): string | null {
  const last = view.last_sleep
  if (!last || last.outcome === null || last.outcome === 'asleep' || last.outcome === 'discarded') return null
  return last.message || 'The sandbox stayed awake.'
}

// payerLabel says who pays for a session's model, in words.
export function payerLabel(payer: SessionModel['payer']): string {
  if (payer === 'orca_credit') return 'Orca credit'
  if (payer === 'own_key') return 'your own provider key'
  return 'unknown'
}

// SessionUsageRow is one line of a session's usage: a stable key and raw
// quantity for plain output, and a label and formatted figure for a person.
export type SessionUsageRow = { key: string; plain: string; label: string; shown: string }

// The meters a session view shows, in order (money-payments, Session view):
// tokens, model calls, web searches, machine time. Each carries its server
// cost; a call's money is on model calls, so these add up to the session's
// cost.
const SESSION_METERS: { meter: string; label: string; unit: string }[] = [
  { meter: 'model_tokens', label: 'tokens', unit: 'tokens' },
  { meter: 'model_calls', label: 'model calls', unit: 'calls' },
  { meter: 'web_searches', label: 'web searches', unit: 'searches' },
  { meter: 'compute_seconds', label: 'machine time', unit: 'seconds' },
]

// sessionUsageRows renders a session's /api/usage summary (grouped by model):
// the total cost, then each meter's quantity and cost, then each model's
// tokens and its cost across every meter (group_costs: a call's money is on
// its call row, not its tokens). Every figure is the server's.
export function sessionUsageRows(summary: UsageSummary): SessionUsageRow[] {
  const figure = (quantity: number, unit: string, cost: number) =>
    cost ? `${formatCount(quantity)} ${unit}, ${usdMicro(cost)}` : `${formatCount(quantity)} ${unit}`
  const rows: SessionUsageRow[] = [
    { key: 'cost', plain: usdMicro(summary.cost_micro_usd), label: 'cost', shown: usdMicro(summary.cost_micro_usd) },
  ]
  for (const { meter, label, unit } of SESSION_METERS) {
    const m = summary.meters.find((x) => x.meter === meter)
    const quantity = m?.quantity ?? 0
    rows.push({ key: meter, plain: String(quantity), label, shown: figure(quantity, m?.unit ?? unit, m?.cost_micro_usd ?? 0) })
    if (meter !== 'model_tokens') continue
    // Each model's tokens and cost. Rows with no model (machine time) are
    // not a model's: their cost is in their own meter's row.
    for (const g of (summary.groups ?? []).filter((x) => x.meter === 'model_tokens' && x.key !== null)) {
      rows.push({ key: `model_tokens:${g.key}`, plain: String(g.quantity), label: `  ${g.key}`, shown: figure(g.quantity, 'tokens', groupCost(summary, g.key) ?? 0) })
    }
  }
  return rows
}
