// Tool results for the MCP server: list summaries, and fitting any result
// into MAX_RESULT_BYTES while keeping it valid JSON.
//
// A coding agent parses what a tool returns. A result cut mid-way is not
// JSON, so the agent's parser fails and it falls back to grep. Instead, a
// page too large drops items from its end and says where to continue; any
// other value has its longest strings shortened, each marked, and says how
// to get the whole item.
import type { Agent, AgentSession, AgentSessionItem } from 'openai/resources/beta/agents/agents'

import type { Page } from '../lib/api.js'
import { itemRole, messageText } from '../lib/sessions.js'

// Result payloads are capped so one tool call cannot flood an agent's
// context window.
export const MAX_RESULT_BYTES = 50_000

// No string is shortened below this many characters, so what is left of it
// still says what it was.
const MIN_STRING_CHARS = 200

// A tool call's arguments or output in list_session_items is cut to this
// many characters; messages keep their whole text.
export const ITEM_BODY_CHARS = 2_000

const render = (value: unknown): string => JSON.stringify(value, null, 1) ?? 'null'
const sizeOf = (text: string): number => Buffer.byteLength(text, 'utf8')
const fits = (value: unknown, max: number): boolean => sizeOf(render(value)) <= max

// -- Summaries --------------------------------------------------------------------

export function mapPage<T, U>(page: Page<T>, summary: (item: T) => U): Page<U> {
  return { ...page, items: page.items.map(summary) }
}

// agentSummary is what picks an agent: no instructions (one agent's run to
// 9 KB). get_agent returns the rest.
export function agentSummary(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    model: agent.model,
    tools: [...new Set((agent.tools ?? []).map((t) => t.type))],
    created_at: agent.created_at,
  }
}

// sessionSummary drops the agent snapshot a session carries (instructions
// and tools included). get_session returns the rest.
export function sessionSummary(session: AgentSession) {
  return {
    id: session.id,
    status: session.status,
    agent: { id: session.agent?.id, name: session.agent?.name ?? null, model: session.agent?.model },
    environment: session.environment?.type ?? null,
    created_at: session.created_at,
    last_active_at: session.last_active_at,
    ...(session.error ? { error: session.error } : {}),
  }
}

// itemSummary keeps a message's whole text, as written, and cuts a tool
// call's long arguments and output.
export function itemSummary(item: AgentSessionItem) {
  if (item.type === 'message' || item.type === 'agent_message') {
    const turnId = (item as { turn_id?: string | null }).turn_id ?? null
    return { id: item.id ?? null, type: item.type, role: itemRole(item), turn_id: turnId, text: messageText(item) }
  }
  return shortenStrings(item, ITEM_BODY_CHARS)
}

// -- Fitting ----------------------------------------------------------------------

function shortenString(text: string, chars: number): string {
  if (text.length <= chars) return text
  return `${text.slice(0, chars)}... [shortened from ${text.length} characters]`
}

// shortenStrings copies value with every string longer than chars cut to
// chars and marked.
export function shortenStrings<T>(value: T, chars: number): T {
  if (typeof value === 'string') return shortenString(value, chars) as T
  if (Array.isArray(value)) return value.map((v) => shortenStrings(v, chars)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenStrings(v, chars)])) as T
  }
  return value
}

function longestString(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((m: number, v) => Math.max(m, longestString(v)), 0)
  if (value && typeof value === 'object') return longestString(Object.values(value))
  return 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function isPage(value: unknown): value is Page<unknown> & Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.items) && typeof value.hasMore === 'boolean' && 'lastId' in value
}

function lastIdOf(items: unknown[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const id = (items[i] as { id?: unknown } | null)?.id
    if (typeof id === 'string') return id
  }
  return null
}

// largestFitting is the largest n in [lo, hi] for which make(n) fits, by
// binary search (a larger n never makes a smaller result), or null.
function largestFitting<T>(lo: number, hi: number, make: (n: number) => T, max: number): T | null {
  let best: T | null = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = make(mid)
    if (fits(candidate, max)) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

// fitPage keeps the page's first items that fit and points at the rest.
function fitPage(page: Page<unknown> & Record<string, unknown>, full: string, max: number): unknown {
  const total = page.items.length
  const cut = (n: number) => {
    const items = page.items.slice(0, n)
    const lastId = lastIdOf(items)
    const rest = lastId ? `pass after: ${JSON.stringify(lastId)} for the rest` : 'narrow the request for the rest'
    return { ...page, items, hasMore: true, lastId, truncated: `${n} of ${total} items fit in ${max} bytes; ${rest}` }
  }
  if (total === 0) return fitValue(page, full, max)
  return largestFitting(1, total - 1, cut, max) ?? fitValue(cut(1), full, max)
}

// fitValue shortens the value's longest strings until it fits. A value that
// still does not fit (a huge array of short strings) loses array entries
// from the end, each cut array saying how many it lost.
function fitValue(value: unknown, full: string, max: number): unknown {
  const note = `strings ending in "[shortened from N characters]" were cut to fit ${max} bytes; ${full}`
  const marked = (v: unknown) => (isRecord(v) ? { ...v, shortened: note } : v)
  return (
    largestFitting(MIN_STRING_CHARS, longestString(value) - 1, (chars) => marked(shortenStrings(value, chars)), max) ??
    trimArrays(marked(shortenStrings(value, MIN_STRING_CHARS)), max)
  )
}

// trimArrays halves the largest array until the value fits, ending each cut
// array with a string that says how many entries it lost. It never fails:
// the last resort is a note in place of the value.
function trimArrays(value: unknown, max: number): unknown {
  let current = value
  for (let round = 0; round < 64 && !fits(current, max); round++) {
    const next = halveLargestArray(current)
    if (next === current) break
    current = next
  }
  if (fits(current, max)) return current
  return { truncated: `the result did not fit in ${max} bytes; narrow the request` }
}

// entriesOf splits an array cut before into its entries and how many it
// already lost.
function entriesOf(array: unknown[]): { entries: unknown[]; lost: number } {
  const last = array.at(-1)
  const lost = typeof last === 'string' ? /^\[cut (\d+) more entries/.exec(last)?.[1] : undefined
  return lost ? { entries: array.slice(0, -1), lost: Number(lost) } : { entries: array, lost: 0 }
}

function halveLargestArray(value: unknown): unknown {
  let target: unknown[] | null = null
  let targetSize = 0
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      const size = sizeOf(render(v))
      if (entriesOf(v).entries.length > 1 && size > targetSize) {
        target = v
        targetSize = size
      }
      v.forEach(visit)
    } else if (isRecord(v)) {
      Object.values(v).forEach(visit)
    }
  }
  visit(value)
  if (!target) return value
  const rebuild = (v: unknown): unknown => {
    if (Array.isArray(v) && v === target) {
      const { entries, lost } = entriesOf(v)
      const keep = Math.ceil(entries.length / 2)
      return [...entries.slice(0, keep), `[cut ${lost + entries.length - keep} more entries to fit; narrow the request]`]
    }
    if (Array.isArray(v)) return v.map(rebuild)
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebuild(x)]))
    return v
  }
  return rebuild(value)
}

// fitResult renders a tool's value as JSON of at most max bytes, always
// valid. full says how to get a whole item when strings are shortened.
export function fitResult(value: unknown, full = 'narrow the request', max = MAX_RESULT_BYTES): string {
  const text = render(value)
  if (sizeOf(text) <= max) return text
  return render(isPage(value) ? fitPage(value, full, max) : fitValue(value, full, max))
}
