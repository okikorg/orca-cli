import { jsonResponse, type RouteHandler } from './fetch-mock.js'
import { chunkedBytes, streamResponse } from './sse-stream.js'

export const AGENT_ID = 'agent_' + '1'.repeat(32)
export const SESSION_ID = 'sess_' + 'a'.repeat(32)

export function session(status = 'idle', extra: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    object: 'agent.session',
    agent: { id: AGENT_ID },
    environment: { type: 'none' },
    created_at: 1_783_245_600,
    last_active_at: 1_783_245_600,
    metadata: {},
    vault_ids: [],
    status,
    required_actions: [],
    error: null,
    usage: null,
    ...extra,
  }
}

function turn(id: string, status: string, error: unknown = null) {
  return { id, object: 'agent.session.turn', session_id: SESSION_ID, agent_id: AGENT_ID, subagent_id: null, status, error }
}

let n = 0
const ev = (event: Record<string, unknown>) => ({ event_id: `evt_${++n}`, session_id: SESSION_ID, ...event })

// turnEvents is one coordinator turn as the server streams it: created, a
// tool call, two message items of text, then the given ending and idle.
export function turnEvents(ending: 'completed' | 'failed' = 'completed'): Record<string, unknown>[] {
  const t = 'turn_1'
  const tool = { id: 'call_1', type: 'mcp_call', server_label: 'docs', name: 'search', status: 'in_progress', turn_id: t }
  return [
    ev({ type: 'agent.session.turn.created', turn_id: t, turn: turn(t, 'in_progress') }),
    ev({ type: 'agent.session.turn.output_text.delta', turn_id: t, item_id: 'msg_1', delta: 'Let me look.', output_index: 0, content_index: 0 }),
    ev({ type: 'agent.session.turn.item.added', turn_id: t, item: tool, output_index: 1 }),
    ev({ type: 'agent.session.turn.item.done', turn_id: t, item: { ...tool, status: 'completed' }, output_index: 1 }),
    ev({ type: 'agent.session.turn.output_text.delta', turn_id: t, item_id: 'msg_2', delta: 'Hello ', output_index: 2, content_index: 0 }),
    ev({ type: 'agent.session.turn.output_text.delta', turn_id: t, item_id: 'msg_2', delta: 'there', output_index: 2, content_index: 0 }),
    ending === 'completed'
      ? ev({ type: 'agent.session.turn.completed', turn_id: t, turn: turn(t, 'completed'), usage: null })
      : ev({
          type: 'agent.session.turn.failed',
          turn_id: t,
          turn: turn(t, 'failed', { code: 'usage_limit_exceeded', message: 'Out of credit' }),
          usage: null,
        }),
    ev({ type: 'agent.session.idle', session: session() }),
  ]
}

// sseRoute serves events as an SSE body split at awkward byte boundaries.
export function sseRoute(events: Record<string, unknown>[]): RouteHandler {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return () => streamResponse(chunkedBytes(body, [7, 13, 50]))
}

// turnRoutes is everything the openai session stream helper calls for one
// turn on SESSION_ID: the idle check, the event subscription, and the input.
export function turnRoutes(events: Record<string, unknown>[]): Record<string, RouteHandler> {
  return {
    [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(session()),
    [`GET /v1/agents/sessions/${SESSION_ID}/events`]: sseRoute(events),
    [`POST /v1/agents/sessions/${SESSION_ID}/events`]: () => new Response(null, { status: 204 }),
  }
}

export function agent(extra: Record<string, unknown> = {}) {
  return { id: AGENT_ID, object: 'agent', name: 'support', model: 'openai/gpt-5', created_at: 1_783_245_600, ...extra }
}

// orgKeyRoutes are what an organization key's session commands read first:
// whoami (no published agent) and the agent by its id.
export function orgKeyRoutes(): Record<string, RouteHandler> {
  return {
    'GET /api/whoami': jsonResponse({ object: 'whoami', tenant: 'org_1', actor: 'key_1', role: 'admin', agent: null }),
    [`GET /v1/agents/${AGENT_ID}`]: jsonResponse(agent()),
  }
}

// publishedKeyRoutes: a published agent's key, whose sessions must name the
// environment and vaults its publisher fixed.
export function publishedKeyRoutes(environment: Record<string, unknown> = { type: 'none' }, vaultIds: string[] = []): Record<string, RouteHandler> {
  return {
    'GET /api/whoami': jsonResponse({
      object: 'whoami',
      tenant: 'org_1',
      actor: 'key_pub',
      role: 'member',
      agent: AGENT_ID,
      environment,
      vault_ids: vaultIds,
    }),
  }
}
