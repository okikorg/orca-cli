import { list } from './cli.js'
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
          turn: turn(t, 'failed', { code: 'usage_limit_exceeded', message: 'Out of credit', param: 'orca_credit' }),
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
  return { id: AGENT_ID, object: 'agent', name: 'support', model: 'orca/openrouter/openai/gpt-5.6-luna', created_at: 1_783_245_600, ...extra }
}

// agentRoute is the agent by its id, which a new session's agent resolves to.
export function agentRoute(): Record<string, RouteHandler> {
  return { [`GET /v1/agents/${AGENT_ID}`]: jsonResponse(agent()) }
}

// sessionModelRoute is GET /api/sessions/{id}/model: the model the session's
// next turn uses (a switch, when one was made), the agent's, and who pays.
export function sessionModelRoute(
  model = 'orca/openrouter/openai/gpt-5.6-luna',
  agentModel = 'orca/openrouter/openai/gpt-5.6-luna',
): Record<string, RouteHandler> {
  const payer = model.startsWith('orca/') ? 'orca_credit' : 'own_key'
  return {
    [`GET /api/sessions/${SESSION_ID}/model`]: jsonResponse({
      object: 'session.model',
      session_id: SESSION_ID,
      model,
      agent_model: agentModel,
      payer,
    }),
  }
}

// hostedSession is SESSION_ID in a managed sandbox, environment env_1.
export function hostedSession(status = 'idle') {
  return session(status, { environment: { type: 'openai_hosted', id: 'env_1', files: [] } })
}

// artifact is one of SESSION_ID's artifacts, five bytes, from env_1.
export function artifact(id: string, path: string, turn: string, created = 1_783_245_600) {
  return {
    id,
    object: 'agent.session.artifact',
    created_at: created,
    environment_id: 'env_1',
    path,
    session_id: SESSION_ID,
    size_bytes: 5,
    turn_id: turn,
  }
}

// uploadedFile is what POST /v1/files answers for a staged file.
export function uploadedFile(id: string, filename: string, bytes = 5) {
  return { id, object: 'file', bytes, created_at: 1_783_245_600, filename, purpose: 'user_data', status: 'processed' }
}

// bytesRoute serves raw bytes, as a content route does.
export function bytesRoute(bytes: number[]): () => Response {
  return () => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/octet-stream' } })
}

export const TEMPLATE_ID = 'envtmpl_' + 'b'.repeat(32)
export const VAULT_ID = 'vault_' + 'c'.repeat(32)

export function template(id = TEMPLATE_ID, name: string | null = 'seo-helper') {
  return {
    id,
    object: 'agent.environment.template',
    name,
    capability_directories: [],
    files: [],
    network: { access: 'disabled' },
    packages: {},
    plugins: [],
    skills: [],
    created_at: 1_783_245_600,
    updated_at: 1_783_245_600,
  }
}

export function vault(id = VAULT_ID, name: string | null = 'dataforseo') {
  return { id, object: 'vault', name, metadata: {}, created_at: 1_783_245_600 }
}

const TEMPLATES = '/v1/agents/environments/templates'

// templateRoute and vaultRoute answer one by its id: an id the user typed is
// retrieved and then used as given.
export function templateRoute(id = TEMPLATE_ID, name: string | null = 'seo-helper'): Record<string, RouteHandler> {
  return { [`GET ${TEMPLATES}/${id}`]: jsonResponse(template(id, name)) }
}

export function vaultRoute(id = VAULT_ID, name: string | null = 'dataforseo'): Record<string, RouteHandler> {
  return { [`GET /v1/vaults/${id}`]: jsonResponse(vault(id, name)) }
}

const notFound = (what: string) => jsonResponse({ error: { message: `No such ${what}` } }, { status: 404 })

// templateByName and vaultByName are what a name costs: its retrieve as an
// id answers 404, then the list is scanned for the name.
export function templateByName(name: string, rows: ReturnType<typeof template>[]): Record<string, RouteHandler> {
  return {
    [`GET ${TEMPLATES}/${name}`]: notFound('environment template'),
    [`GET ${TEMPLATES}?limit=100`]: jsonResponse(list(rows)),
  }
}

export function vaultByName(name: string, rows: ReturnType<typeof vault>[]): Record<string, RouteHandler> {
  return {
    [`GET /v1/vaults/${name}`]: notFound('vault'),
    'GET /v1/vaults?limit=100': jsonResponse(list(rows)),
  }
}
