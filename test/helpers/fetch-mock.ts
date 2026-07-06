import { vi } from 'vitest'

export type RecordedCall = {
  method: string
  host: string
  path: string
  headers: Record<string, string>
  body?: string
}

export type RouteHandler = (call: RecordedCall) => Response

// stubFetch replaces global fetch with a route table keyed by
// "METHOD /path" (query string included). Unmatched requests throw so a
// typo in a test surfaces as a failure, not a hang.
export function stubFetch(routes: Record<string, RouteHandler | Response>): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const method = (init?.method ?? 'GET').toUpperCase()
      const call: RecordedCall = {
        method,
        host: url.host,
        path: url.pathname + url.search,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : undefined,
      }
      calls.push(call)
      const key = `${method} ${call.path}`
      const handler = routes[key]
      if (!handler) {
        throw new TypeError(`fetch-mock: no route for "${key}"`)
      }
      return typeof handler === 'function' ? handler(call) : handler.clone()
    },
  )
  return calls
}

export function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): RouteHandler {
  return () =>
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
}
