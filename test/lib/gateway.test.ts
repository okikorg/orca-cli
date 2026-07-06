import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExitCode } from '../../src/lib/errors.js'
import {
  GatewayClient,
  GatewayError,
  GatewayStreamBuffer,
  decodeFrame,
  mapGatewayError,
  type ChatEvent,
} from '../../src/lib/gateway.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { chunkedBytes, streamResponse } from '../helpers/sse-stream.js'

const KEY = 'ao_dev_' + 'k'.repeat(32)
const BASE = { gatewayUrl: 'http://gw:8090', tenant: 'org_x', agent: 'support', chatKey: KEY }

// The public gateway multiplexes on the SSE `event:` field, which the shared
// sse-stream helper does not emit, so build gateway frames locally.
function gwFrames(events: { event: string; data: unknown }[], opts?: { pings?: boolean }): string {
  let out = ''
  events.forEach((e, i) => {
    if (opts?.pings && i > 0) out += ': ping\n\n'
    out += `id: prun_abc:${i}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`
  })
  return out
}

function sseRoute(raw: string, sizes = [1000]) {
  return () => streamResponse(chunkedBytes(raw, sizes))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GatewayStreamBuffer', () => {
  it('yields frames with event names across arbitrary chunk boundaries', () => {
    const raw =
      'event: delta\ndata: {"text":"a"}\n\n' + 'event: done\ndata: {"message":"a"}\n\n'
    for (const size of [1, 3, 8, raw.length]) {
      const buf = new GatewayStreamBuffer()
      const frames = []
      for (let i = 0; i < raw.length; i += size) frames.push(...buf.push(raw.slice(i, i + size)))
      expect(frames.map((f) => f.event)).toEqual(['delta', 'done'])
      expect(frames[0].data).toBe('{"text":"a"}')
    }
  })

  it('captures a comment heartbeat as a comment-only frame', () => {
    const buf = new GatewayStreamBuffer()
    const [frame] = buf.push(': ping\n\n')
    expect(frame).toEqual({ event: 'message', data: '', comment: 'ping' })
  })

  it('handles CRLF line endings', () => {
    const buf = new GatewayStreamBuffer()
    const [frame] = buf.push('event: delta\r\ndata: {"text":"x"}\r\n\n')
    expect(frame.event).toBe('delta')
    expect(frame.data).toBe('{"text":"x"}')
  })
})

describe('decodeFrame', () => {
  it('decodes delta / tool / done', () => {
    expect(decodeFrame({ event: 'delta', data: '{"text":"hi"}', comment: null })).toEqual({
      type: 'delta',
      text: 'hi',
    })
    expect(decodeFrame({ event: 'tool', data: '{"id":"tc1","name":"web_search","status":"ok"}', comment: null })).toEqual(
      { type: 'tool', id: 'tc1', name: 'web_search', status: 'ok' },
    )
    expect(
      decodeFrame({ event: 'done', data: '{"conversation_id":"conv_1","public_run_id":"prun_9","message":"done"}', comment: null }),
    ).toEqual({ type: 'done', conversationId: 'conv_1', publicRunId: 'prun_9', message: 'done' })
  })

  it('accepts either code (SSE) or error (HTTP body) on error frames', () => {
    expect(decodeFrame({ event: 'error', data: '{"code":"upstream","message":"boom"}', comment: null })).toMatchObject(
      { type: 'error', code: 'upstream', message: 'boom' },
    )
    expect(decodeFrame({ event: 'error', data: '{"error":"rate_limited","message":"slow"}', comment: null })).toMatchObject(
      { type: 'error', code: 'rate_limited', message: 'slow' },
    )
  })

  it('maps a comment frame to ping and unknown events to null', () => {
    expect(decodeFrame({ event: 'message', data: '', comment: 'ping' })).toEqual({ type: 'ping', comment: 'ping' })
    expect(decodeFrame({ event: 'whoknows', data: '{}', comment: null })).toBeNull()
  })

  it('defaults a tool status to running and name to tool', () => {
    expect(decodeFrame({ event: 'tool', data: '{"id":"t"}', comment: null })).toEqual({
      type: 'tool',
      id: 't',
      name: 'tool',
      status: 'running',
    })
  })
})

describe('GatewayClient.streamChat request shape', () => {
  it('POSTs to the tenant/agent stream path with the bearer chat key and body', async () => {
    const calls = stubFetch({
      'POST /v1/chat/org_x/support/stream': sseRoute(
        gwFrames([{ event: 'done', data: { conversation_id: 'conv_1', message: 'ok' } }]),
      ),
    })
    const client = new GatewayClient(BASE)
    await client.streamChat('hi there', {
      conversationId: 'conv_prev',
      endUserId: 'user_9',
      signal: new AbortController().signal,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/v1/chat/org_x/support/stream')
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(calls[0].headers.Accept).toContain('text/event-stream')
    expect(JSON.parse(calls[0].body!)).toEqual({
      message: 'hi there',
      conversation_id: 'conv_prev',
      metadata: { end_user_id: 'user_9' },
    })
  })

  it('omits conversation_id and metadata when not provided', async () => {
    const calls = stubFetch({
      'POST /v1/chat/org_x/support/stream': sseRoute(gwFrames([{ event: 'done', data: { message: 'ok' } }])),
    })
    await new GatewayClient(BASE).streamChat('hello', { signal: new AbortController().signal })
    expect(JSON.parse(calls[0].body!)).toEqual({ message: 'hello' })
  })
})

describe('GatewayClient.streamChat streaming', () => {
  it('concatenates deltas across split frames and returns the done result', async () => {
    const raw = gwFrames(
      [
        { event: 'delta', data: { text: 'Here is ' } },
        { event: 'delta', data: { text: 'the summary世界' } },
        { event: 'done', data: { conversation_id: 'conv_7', public_run_id: 'prun_1', message: 'Here is the summary世界' } },
      ],
      { pings: true },
    )
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(raw, [3, 7, 5]) })
    const got: ChatEvent[] = []
    const result = await new GatewayClient(BASE).streamChat('q', {
      signal: new AbortController().signal,
      onEvent: (e) => got.push(e),
    })
    expect(result.terminated).toBe('done')
    expect(result.message).toBe('Here is the summary世界')
    expect(result.conversationId).toBe('conv_7')
    expect(result.publicRunId).toBe('prun_1')
    expect(got.filter((e) => e.type === 'delta')).toHaveLength(2)
    expect(got.some((e) => e.type === 'ping')).toBe(true)
  })

  it('surfaces tool events when the agent exposes them', async () => {
    const raw = gwFrames([
      { event: 'tool', data: { id: 'tc1', name: 'web_search', status: 'running' } },
      { event: 'tool', data: { id: 'tc1', name: 'web_search', status: 'ok' } },
      { event: 'delta', data: { text: 'answer' } },
      { event: 'done', data: { message: 'answer' } },
    ])
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(raw, [5]) })
    const got: ChatEvent[] = []
    const result = await new GatewayClient(BASE).streamChat('q', {
      signal: new AbortController().signal,
      onEvent: (e) => got.push(e),
    })
    expect(result.terminated).toBe('done')
    const tools = got.filter((e) => e.type === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools.at(-1)).toMatchObject({ name: 'web_search', status: 'ok' })
  })

  it('works with no tool frames present (exposeToolEvents off)', async () => {
    const raw = gwFrames([
      { event: 'delta', data: { text: 'just text' } },
      { event: 'done', data: { message: 'just text' } },
    ])
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(raw, [4]) })
    const got: ChatEvent[] = []
    const result = await new GatewayClient(BASE).streamChat('q', {
      signal: new AbortController().signal,
      onEvent: (e) => got.push(e),
    })
    expect(result.message).toBe('just text')
    expect(got.some((e) => e.type === 'tool')).toBe(false)
  })

  it('returns a terminal error event as terminated=error, not a throw', async () => {
    const raw = gwFrames([
      { event: 'delta', data: { text: 'partial' } },
      { event: 'error', data: { code: 'upstream', message: 'conductor failed mid-run', public_run_id: 'prun_2' } },
    ])
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(raw, [6]) })
    const result = await new GatewayClient(BASE).streamChat('q', { signal: new AbortController().signal })
    expect(result.terminated).toBe('error')
    expect(result.errorCode).toBe('upstream')
    expect(result.message).toBe('conductor failed mid-run')
    expect(result.publicRunId).toBe('prun_2')
  })

  it('reports a stream that closes with no terminal frame as dropped', async () => {
    const raw = gwFrames([{ event: 'delta', data: { text: 'half' } }])
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(raw, [1000]) })
    const result = await new GatewayClient(BASE).streamChat('q', { signal: new AbortController().signal })
    expect(result.terminated).toBe('dropped')
    expect(result.message).toBe('half')
  })

  it('returns aborted when the caller signal fires mid-stream', async () => {
    const controller = new AbortController()
    stubFetch({
      'POST /v1/chat/org_x/support/stream': () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"x"}\n\n'))
            controller.signal.addEventListener('abort', () =>
              c.error(new DOMException('The operation was aborted', 'AbortError')),
            )
          },
        })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    const result = await new GatewayClient(BASE).streamChat('q', {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'delta') controller.abort()
      },
    })
    expect(result.terminated).toBe('aborted')
    expect(result.message).toBe('x')
  })
})

describe('GatewayClient.streamChat HTTP rejections', () => {
  const cases: { status: number; body: unknown; retryAfter?: string }[] = [
    { status: 401, body: { error: 'unauthorized', message: 'invalid or revoked API key' } },
    { status: 403, body: { error: 'forbidden', message: 'not your agent' } },
    { status: 404, body: { error: 'not_found', message: 'published agent not found' } },
    { status: 400, body: { error: 'invalid_request', message: 'message: required' } },
    { status: 429, body: { error: 'rate_limited', message: 'slow down' }, retryAfter: '30' },
    { status: 502, body: { error: 'upstream', message: 'conductor failed' } },
  ]
  for (const c of cases) {
    it(`throws GatewayError on ${c.status}`, async () => {
      stubFetch({
        'POST /v1/chat/org_x/support/stream': jsonResponse(c.body, {
          status: c.status,
          headers: c.retryAfter ? { 'Retry-After': c.retryAfter } : undefined,
        }),
      })
      await expect(
        new GatewayClient(BASE).streamChat('q', { signal: new AbortController().signal }),
      ).rejects.toBeInstanceOf(GatewayError)
    })
  }

  it('rejects a 200 that is not an event-stream', async () => {
    stubFetch({ 'POST /v1/chat/org_x/support/stream': jsonResponse({ message: 'not streamed' }) })
    await expect(
      new GatewayClient(BASE).streamChat('q', { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(GatewayError)
  })
})

describe('mapGatewayError exit codes', () => {
  const ctx = { gatewayUrl: 'http://gw:8090', agent: 'support' }
  const map: [number, number][] = [
    [401, ExitCode.Auth],
    [403, ExitCode.Auth],
    [404, ExitCode.NotFound],
    [400, ExitCode.Usage],
    [429, ExitCode.Failure],
    [502, ExitCode.Failure],
    [500, ExitCode.Failure],
  ]
  for (const [status, exit] of map) {
    it(`${status} -> exit ${exit}`, () => {
      const cli = mapGatewayError(new GatewayError(status, { error: 'x', message: 'm' }), ctx)
      expect(cli.exitCode).toBe(exit)
    })
  }

  it('401 hint names orca agents keys create and the env var', () => {
    const cli = mapGatewayError(new GatewayError(401, { error: 'unauthorized' }), ctx)
    expect(cli.detail?.join(' ')).toContain('orca agents keys create support')
    expect(cli.detail?.join(' ')).toContain('ORCA_CHAT_KEY')
  })

  it('429 surfaces the Retry-After hint', () => {
    const cli = mapGatewayError(new GatewayError(429, { error: 'rate_limited' }, 42), ctx)
    expect(cli.message).toContain('42s')
  })

  it('maps a TypeError (host unreachable) to a failure', () => {
    const cli = mapGatewayError(new TypeError('fetch failed'), ctx)
    expect(cli.exitCode).toBe(ExitCode.Failure)
    expect(cli.message).toContain('cannot reach')
  })
})
