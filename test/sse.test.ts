import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiClient } from '../src/lib/api.js'
import { SSEBuffer, decodeRunEvent, streamRunEvents } from '../src/lib/sse.js'
import type { RunEvent } from '../src/lib/types.js'
import { jsonResponse, stubFetch } from './helpers/fetch-mock.js'
import { chunkedBytes, sseFrames, streamResponse } from './helpers/sse-stream.js'

const OPTS = { apiUrl: 'http://test:8080', apiKey: 'ao_dev_k'.padEnd(30, 'x'), contextName: 'test' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SSEBuffer', () => {
  it('yields data payloads across arbitrary chunk boundaries', () => {
    const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\n'
    for (const size of [1, 3, 7, raw.length]) {
      const sse = new SSEBuffer()
      const out: string[] = []
      for (let i = 0; i < raw.length; i += size) {
        out.push(...sse.push(raw.slice(i, i + size)))
      }
      expect(out).toEqual(['{"a":1}', '{"b":2}'])
    }
  })

  it('drops comment heartbeats and joins multi-line data', () => {
    const sse = new SSEBuffer()
    const out = sse.push(': ping\n\ndata: line1\ndata: line2\n\n: ping\n\n')
    expect(out).toEqual(['line1\nline2'])
  })

  it('handles CRLF line endings', () => {
    const sse = new SSEBuffer()
    const out = sse.push('data: {"a":1}\r\n\n')
    expect(out).toEqual(['{"a":1}'])
  })

  it('flushes a trailing block without a terminator', () => {
    const sse = new SSEBuffer()
    expect(sse.push('data: tail')).toEqual([])
    expect(sse.flush()).toBe('tail')
  })
})

describe('decodeRunEvent', () => {
  it('wraps non-JSON payloads as progress', () => {
    expect(decodeRunEvent('plain words')).toEqual({ type: 'progress', message: 'plain words' })
  })
})

describe('streamRunEvents', () => {
  const events: RunEvent[] = [
    { type: 'progress', message: 'starting' },
    { type: 'assistant', message: 'hello éé 世界' },
    { type: 'result', message: 'done' },
  ]

  it('delivers every event once and returns the terminal status', async () => {
    stubFetch({
      'GET /api/runs/r1/stream': () =>
        streamResponse(chunkedBytes(sseFrames(events, { pings: true }), [5])),
      'GET /api/runs/r1': jsonResponse({ id: 'r1', status: 'ok', subTask: {}, startedAt: '', events: [] }),
    })
    const got: RunEvent[] = []
    const status = await streamRunEvents(new ApiClient(OPTS), 'r1', (e) => got.push(e), {
      signal: new AbortController().signal,
    })
    expect(status).toBe('ok')
    expect(got).toEqual(events)
  })

  it('reconnects after a drop and skips replayed events', async () => {
    let call = 0
    let probes = 0
    stubFetch({
      'GET /api/runs/r2/stream': () => {
        call++
        if (call === 1) {
          // First connection dies after two events.
          return streamResponse(chunkedBytes(sseFrames(events.slice(0, 2)), [1000]))
        }
        // Reconnect replays the full buffer, then the final event.
        return streamResponse(chunkedBytes(sseFrames(events), [1000]))
      },
      'GET /api/runs/r2': () => {
        probes++
        return new Response(
          JSON.stringify({
            id: 'r2',
            status: probes === 1 ? 'running' : 'ok',
            subTask: {},
            startedAt: '',
            events: [],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      },
    })
    const got: RunEvent[] = []
    const status = await streamRunEvents(new ApiClient(OPTS), 'r2', (e) => got.push(e), {
      signal: new AbortController().signal,
    })
    expect(status).toBe('ok')
    expect(got).toEqual(events)
    expect(call).toBe(2)
  })

  it('throws on an HTTP-level rejection', async () => {
    stubFetch({
      'GET /api/runs/r3/stream': jsonResponse({ error: 'unknown run' }, { status: 404 }),
    })
    await expect(
      streamRunEvents(new ApiClient(OPTS), 'r3', () => {}, {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('returns running when aborted mid-stream', async () => {
    const controller = new AbortController()
    stubFetch({
      'GET /api/runs/r4/stream': () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"progress","message":"x"}\n\n'))
            // Never closes on its own; mirror real fetch by erroring the
            // body when the caller's signal aborts.
            controller.signal.addEventListener('abort', () =>
              c.error(new DOMException('The operation was aborted', 'AbortError')),
            )
          },
        })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    const got: RunEvent[] = []
    const p = streamRunEvents(new ApiClient(OPTS), 'r4', (e) => {
      got.push(e)
      controller.abort()
    }, { signal: controller.signal })
    await expect(p).resolves.toBe('running')
    expect(got).toHaveLength(1)
  })
})
