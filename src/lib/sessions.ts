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

import { resolveAgentId } from './agents.js'
import type { ApiClient } from './api.js'
import { CliError, ExitCode } from './errors.js'
import { formatCount } from './format.js'
import { stripControlSequences } from './markdown.js'
import { usdMicro } from './money.js'
import type { UsageSummary } from './types.js'

export type ChatToolStatus = 'running' | 'ok' | 'error'

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name?: string; status: ChatToolStatus }

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

function toolStatus(status: string): ChatToolStatus {
  if (status === 'completed') return 'ok'
  if (status === 'in_progress') return 'running'
  return 'error'
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
          if (name !== null && item.id && 'status' in item && item.status) {
            opts.onEvent?.({ type: 'tool', id: item.id, name, status: toolStatus(item.status) })
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
      const detail = err.error as { message?: string; code?: string | null } | undefined
      return { terminated: 'error', message: detail?.message ?? err.message, errorCode: detail?.code ?? undefined }
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
// or the name of the tool a call used. Remote text, so control bytes are
// stripped before it reaches any sink.
export function itemText(item: AgentSessionItem): string {
  if (item.type === 'message' || item.type === 'agent_message') {
    const parts = (item.content as unknown as { text?: unknown }[])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
    return stripControlSequences(parts.join(' ').replace(/\s+/g, ' ').trim())
  }
  if (item.type === 'function_call_output') return 'tool result'
  const name = toolName(item)
  return name ? `tool ${stripControlSequences(name)}` : item.type
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

// A published agent's key: the one agent it runs, and the environment and
// vaults its publisher fixed, which every session it creates must name.
export type PublishedScope = { agent: string; environment: EnvironmentParam; vaultIds: string[] }

// publishedScope asks the server whether the key is a published agent's.
export async function publishedScope(client: ApiClient): Promise<PublishedScope | null> {
  const me = await client.whoami()
  if (!me.agent) return null
  return {
    agent: me.agent,
    environment: (me.environment ?? { type: 'none' }) as unknown as EnvironmentParam,
    vaultIds: me.vault_ids ?? [],
  }
}

// sessionAgent is the agent a new session runs. A published key runs only
// its own, which it may not read, so a reference must be that agent's id;
// any other key resolves the reference by id, then by name.
export async function sessionAgent(client: ApiClient, ref: string, scope: PublishedScope | null): Promise<string> {
  if (scope) {
    if (ref !== scope.agent) {
      throw new CliError(`this key runs only its published agent ${scope.agent}`, ExitCode.Usage, ['Pass that id, or no agent.'])
    }
    return scope.agent
  }
  return resolveAgentId(await client.v1(), ref)
}

// sessionCreateParams is the one session-create body every command sends.
// A published key's sessions name what its publisher fixed, and nothing
// the user passes can change that.
export function sessionCreateParams(agentId: string, flags: SessionCreateFlags, scope: PublishedScope | null) {
  if (scope) {
    if (flags.sandbox || flags.template !== undefined || flags.vault.length > 0) {
      throw new CliError("a published agent's key runs its agent as published", ExitCode.Usage, [
        'Drop --sandbox, --template and --vault: its publisher chose them.',
      ])
    }
    return { agent_id: agentId, environment: scope.environment, ...(scope.vaultIds.length ? { vault_ids: scope.vaultIds } : {}) }
  }
  return { agent_id: agentId, environment: sessionEnvironment(flags), ...(flags.vault.length ? { vault_ids: flags.vault } : {}) }
}

// SessionView is a session as the CLI shows it: the /v1 object without its
// own usage field, and `usage`, the session's all-time /api/usage summary by
// model (decision 0017), or null for a published agent's key, which cannot
// read usage.
export type SessionView = Omit<AgentSession, 'usage'> & { usage: UsageSummary | null }

// sessionView reads one session and its usage from their one source each.
// `sessions get` and the MCP server's get_session both answer with it.
export async function sessionView(client: ApiClient, id: string): Promise<SessionView> {
  const session = await (await client.v1()).beta.agents.sessions.retrieve(id)
  const scope = await publishedScope(client)
  const usage = scope ? null : await client.usage({ start: 0, session: id, group_by: 'model' })
  // `usage` replaces the /v1 object's own field.
  return { ...session, usage }
}

// SessionUsageRow is one line of a session's usage: a stable key and raw
// quantity for plain output, and a label and formatted figure for a person.
export type SessionUsageRow = { key: string; plain: string; label: string; shown: string }

// The meters a session view shows, in order (money-payments, Session view):
// tokens, web searches, machine time. Each carries its server cost.
const SESSION_METERS: { meter: string; label: string; unit: string }[] = [
  { meter: 'model_tokens', label: 'tokens', unit: 'tokens' },
  { meter: 'web_searches', label: 'web searches', unit: 'searches' },
  { meter: 'compute_seconds', label: 'machine time', unit: 'seconds' },
]

// sessionUsageRows renders a session's /api/usage summary (grouped by model):
// the total cost, then each meter's quantity and cost, then tokens per model.
// Every figure is the server's.
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
    for (const g of (summary.groups ?? []).filter((x) => x.meter === 'model_tokens')) {
      const model = g.key ?? 'unknown'
      rows.push({ key: `model_tokens:${model}`, plain: String(g.quantity), label: `  ${model}`, shown: figure(g.quantity, 'tokens', g.cost_micro_usd) })
    }
  }
  return rows
}
