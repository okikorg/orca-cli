import OpenAI from 'openai'
import type { AgentSessionItem } from 'openai/resources/beta/agents/agents'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { itemText, streamTurn, type ChatEvent } from '../../src/lib/sessions.js'
import { stubFetch } from '../helpers/fetch-mock.js'
import { SESSION_ID, session, turnRoutes } from '../helpers/session-events.js'

const QUERY = 'rust async runtimes 2026'
const NO_SEARCH = 'openai/gpt-x answered without searching the web. Use a model with built-in web search: docs.orcapods.ai/providers#web-search'

// webSearch is a web_search_call item as the server writes it: the new
// server sets action from the start and adds error to a failed search,
// written as status incomplete; an older server sends action null, no
// error, and status failed.
function webSearch(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'web_search_call',
    status,
    turn_id: 'turn_1',
    action: { type: 'search', query: QUERY, queries: null },
    ...extra,
  }
}

const FAILED = webSearch('ws_1', 'incomplete', { error: { code: 'no_search', message: NO_SEARCH } })
const STOPPED = webSearch('ws_2', 'incomplete')
const OLD_FAILED = webSearch('ws_3', 'failed', { action: null })

afterEach(() => {
  vi.unstubAllGlobals()
})

// toolEvents streams one turn whose items are the given web searches, each
// added in progress, then done as given, and returns the folded tool events.
async function toolEvents(items: Record<string, unknown>[]): Promise<Extract<ChatEvent, { type: 'tool' }>[]> {
  let n = 0
  const ev = (event: Record<string, unknown>) => ({ event_id: `evt_${++n}`, session_id: SESSION_ID, ...event })
  const turn = (status: string) => ({ id: 'turn_1', object: 'agent.session.turn', session_id: SESSION_ID, subagent_id: null, status, error: null })
  const events = [
    ev({ type: 'agent.session.turn.created', turn_id: 'turn_1', turn: turn('in_progress') }),
    ...items.flatMap((item, i) => [
      ev({ type: 'agent.session.turn.item.added', turn_id: 'turn_1', item: { ...item, status: 'in_progress', error: undefined }, output_index: i }),
      ev({ type: 'agent.session.turn.item.done', turn_id: 'turn_1', item, output_index: i }),
    ]),
    ev({ type: 'agent.session.turn.completed', turn_id: 'turn_1', turn: turn('completed'), usage: null }),
    ev({ type: 'agent.session.idle', session: session() }),
  ]
  stubFetch(turnRoutes(events))
  const client = new OpenAI({ apiKey: 'test', baseURL: 'http://test/v1', maxRetries: 0 })
  const seen: Extract<ChatEvent, { type: 'tool' }>[] = []
  await streamTurn(client, SESSION_ID, 'search', {
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.type === 'tool') seen.push(event)
    },
  })
  return seen
}

describe('streamTurn web search events', () => {
  it('carries the query while in progress, and the reason when the search failed', async () => {
    const events = await toolEvents([FAILED])
    expect(events).toEqual([
      { type: 'tool', id: 'ws_1', name: 'web_search', status: 'running', query: QUERY },
      { type: 'tool', id: 'ws_1', name: 'web_search', status: 'error', query: QUERY, reason: NO_SEARCH },
    ])
  })

  it('reads an incomplete search without an error as stopped, not failed', async () => {
    const [, done] = await toolEvents([STOPPED])
    expect(done).toEqual({ type: 'tool', id: 'ws_2', name: 'web_search', status: 'stopped', query: QUERY })
  })

  it("reads an older server's failed search, with no action or error, as failed", async () => {
    const [, done] = await toolEvents([OLD_FAILED])
    expect(done).toEqual({ type: 'tool', id: 'ws_3', name: 'web_search', status: 'error' })
  })

  it('strips control bytes from the query and the reason', async () => {
    const item = webSearch('ws_4', 'incomplete', {
      action: { type: 'search', query: 'a\u001b[2J b', queries: null },
      error: { code: 'failed', message: 'could not\u001b[31m finish' },
    })
    const [, done] = await toolEvents([item])
    expect(done).toMatchObject({ query: 'a b', reason: 'could not finish' })
  })
})

describe('itemText web search lines', () => {
  const text = (item: Record<string, unknown>) => itemText(item as unknown as AgentSessionItem)

  it('shows the query, and failed with the reason when the search failed', () => {
    expect(text(webSearch('ws_0', 'completed'))).toBe(`tool web_search "${QUERY}"`)
    expect(text(webSearch('ws_0', 'in_progress'))).toBe(`tool web_search "${QUERY}"`)
    expect(text(FAILED)).toBe(`tool web_search "${QUERY}" failed: ${NO_SEARCH}`)
  })

  it('does not call a search stopped by the turn failed', () => {
    expect(text(STOPPED)).toBe(`tool web_search "${QUERY}"`)
  })

  it("still says failed for an older server's failed search", () => {
    expect(text(OLD_FAILED)).toBe('tool web_search failed')
  })

  it('joins several queries when the search ran more than one', () => {
    expect(text(webSearch('ws_5', 'completed', { action: { type: 'search', query: null, queries: ['one', 'two'] } }))).toBe(
      'tool web_search "one, two"',
    )
  })
})
