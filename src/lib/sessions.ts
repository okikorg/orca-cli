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

import type { ApiClient } from './api.js'
import { CliError, ExitCode } from './errors.js'
import { formatCount } from './format.js'
import { stripControlSequences } from './markdown.js'
import { usdMicro } from './money.js'
import type { SessionModel, UsageSummary } from './types.js'
import { groupCost } from './usage.js'

// A tool line's status: running, done, failed, or stopped (cut off by the
// turn's cancellation or interruption, which is not a failure).
export type ChatToolStatus = 'running' | 'ok' | 'error' | 'stopped'

// A tool event carries a web search's query and, when it failed, the
// server's reason (model-billing, Web search, The item), both one line of
// remote text with control bytes stripped. Other tools carry neither.
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name?: string; status: ChatToolStatus; query?: string; reason?: string }

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
  // `provider_quota` says whose credit ran out.
  errorParam?: string
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

export function itemRole(item: AgentSessionItem): string {
  if (item.type === 'message') return item.role
  if (item.type === 'agent_message') return 'subagent'
  return 'tool'
}

// -- Creating sessions ----------------------------------------------------------

export type SessionCreateFlags = { sandbox?: boolean; template?: string; vault: string[] }

// addSessionCreateOptions attaches the options every session-creating command
// shares: where the session runs and which vaults it may use.
export function addSessionCreateOptions(cmd: Command): Command {
  return cmd
    .option('--sandbox', 'run in a hosted sandbox (default: no environment)')
    .option('--template <id>', 'run in a hosted sandbox built from this environment template')
    .option(
      '--vault <id>',
      'make a vault\'s credentials available to the session (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
}

// sessionEnvironment maps the flags onto the session's environment: none by
// default, a hosted sandbox with --sandbox, built from a template with
// --template.
export function sessionEnvironment(flags: SessionCreateFlags): EnvironmentParam {
  if (flags.template !== undefined) {
    if (!flags.template.trim()) throw new CliError('--template needs an id', ExitCode.Usage)
    return { type: 'openai_hosted', environment_template_id: flags.template }
  }
  if (flags.sandbox) return { type: 'openai_hosted' }
  return { type: 'none' }
}

// sessionCreateParams is the one session-create body every command sends.
export function sessionCreateParams(agentId: string, flags: SessionCreateFlags) {
  return { agent_id: agentId, environment: sessionEnvironment(flags), ...(flags.vault.length ? { vault_ids: flags.vault } : {}) }
}

// SessionView is a session as the CLI shows it: the /v1 object without its
// own usage field, and `usage`, the session's all-time /api/usage summary by
// model (decision 0017); and from /api/sessions/{id}/model, the model its
// next turn uses, the agent's own, and who pays (model-billing D3.13): a
// switch is visible here, while the /v1 object keeps the agent's model.
export type SessionView = Omit<AgentSession, 'usage'> & {
  usage: UsageSummary
  model: string
  agent_model: string
  payer: SessionModel['payer']
}

// sessionView reads one session, its usage and its model from their one
// source each. `sessions get` and the MCP server's get_session both answer
// with it.
export async function sessionView(client: ApiClient, id: string): Promise<SessionView> {
  const session = await (await client.v1()).beta.agents.sessions.retrieve(id)
  const usage = await client.usage({ start: 0, session: id, group_by: 'model' })
  const model = await client.sessionModel(id)
  // `usage` replaces the /v1 object's own field.
  return { ...session, usage, model: model.model, agent_model: model.agent_model, payer: model.payer }
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
