// Client for the PUBLIC chat gateway (`/v1/chat` surface), which is separate
// from the tenant conductor API in api.ts. It talks to published agents: a
// bearer chat key (`ao_<env>_...`) scoped to a single published agent, a
// tenant slug + agent slug in the path, and an SSE token stream.
//
// Contract: docs/openapi-chat.yaml. Event framing mirrors the working
// reference client in demo/published-agent-chat/index.html. Unlike sse.ts
// (which tails the conductor's /api/runs stream and only needs the `data`
// payload), the public gateway multiplexes delta/tool/done/error on the SSE
// `event:` field, so this parser keeps the event name.

import { CliError, ExitCode } from './errors.js'

// -- SSE frame parsing --------------------------------------------------------

export type GatewayFrame = {
  // SSE `event:` name; defaults to "message" when absent, per the spec.
  event: string
  // Concatenated `data:` lines (leading space stripped, joined by newline).
  data: string
  // A `: ...` comment line, if the frame was a comment (e.g. `: ping`).
  comment: string | null
}

// GatewayStreamBuffer accumulates decoded text across chunk boundaries and
// yields complete SSE frames (blocks separated by a blank line). It is the
// event-name-preserving sibling of sse.ts's SSEBuffer; the byte-boundary
// robustness comes from streaming through TextDecoder before push().
export class GatewayStreamBuffer {
  private buf = ''

  push(text: string): GatewayFrame[] {
    this.buf += text
    const out: GatewayFrame[] = []
    let boundary: number
    while ((boundary = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, boundary)
      this.buf = this.buf.slice(boundary + 2)
      out.push(parseFrame(block))
    }
    return out
  }

  // flush drains a trailing frame not terminated by a blank line (the gateway
  // always terminates, but a truncated stream may leave a partial block).
  flush(): GatewayFrame | null {
    const block = this.buf
    this.buf = ''
    return block.trim() ? parseFrame(block) : null
  }
}

function parseFrame(block: string): GatewayFrame {
  let event = 'message'
  const dataParts: string[] = []
  let comment: string | null = null
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(':')) {
      comment = line.slice(1).replace(/^ /, '')
      continue
    }
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataParts.push(line.slice(5).replace(/^ /, ''))
    // id:/retry: lines are ignored; clients dedupe by frame id per the spec.
  }
  return { event, data: dataParts.join('\n'), comment }
}

// -- Normalized events --------------------------------------------------------

export type ChatToolStatus = 'running' | 'ok' | 'error'

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; status: ChatToolStatus }
  | { type: 'done'; conversationId?: string; publicRunId?: string; message: string }
  | { type: 'error'; code: string; message: string; publicRunId?: string }
  | { type: 'ping'; comment: string }

// decodeFrame maps a raw SSE frame to a normalized event, or null for frames
// this client ignores (unknown event names). Heartbeat comment frames become
// a `ping` event so callers can surface liveness if they want.
export function decodeFrame(frame: GatewayFrame): ChatEvent | null {
  if (frame.data === '' && frame.comment !== null) {
    return { type: 'ping', comment: frame.comment }
  }
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(frame.data) as Record<string, unknown>
  } catch {
    payload = {}
  }
  switch (frame.event) {
    case 'delta':
      return { type: 'delta', text: typeof payload.text === 'string' ? payload.text : '' }
    case 'tool':
      return {
        type: 'tool',
        id: str(payload.id) ?? '',
        name: str(payload.name) ?? 'tool',
        status: toolStatus(payload.status),
      }
    case 'done':
      return {
        type: 'done',
        conversationId: str(payload.conversation_id),
        publicRunId: str(payload.public_run_id),
        message: str(payload.message) ?? '',
      }
    case 'error':
      // The SSE error frame uses `code` (openapi-chat.yaml line 133); the HTTP
      // JSON error body uses `error`. Accept either so both paths decode.
      return {
        type: 'error',
        code: str(payload.code) ?? str(payload.error) ?? 'upstream',
        message: str(payload.message) ?? 'upstream error',
        publicRunId: str(payload.public_run_id),
      }
    default:
      return null
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function toolStatus(v: unknown): ChatToolStatus {
  return v === 'ok' || v === 'error' ? v : 'running'
}

// -- Errors -------------------------------------------------------------------

// GatewayError is thrown for HTTP-level rejections before the SSE stream opens
// (bad key, unknown slug, rate limit, upstream). A terminal `error` SSE event
// is NOT this: it is delivered as a ChatEvent and surfaces as a failed turn.
export class GatewayError extends Error {
  status: number
  code: string
  publicRunId?: string
  retryAfter?: number
  constructor(status: number, body: unknown, retryAfter?: number) {
    const rec = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >
    const message = str(rec.message) ?? str(rec.error) ?? `${status}`
    super(message)
    this.status = status
    this.code = str(rec.error) ?? str(rec.code) ?? `http_${status}`
    this.publicRunId = str(rec.public_run_id)
    this.retryAfter = retryAfter
  }
}

// mapGatewayError converts a thrown GatewayError/TypeError into the CliError
// the top-level trap renders, applying the exit-code contract: bad key -> auth
// (3), wrong scope -> auth (3), unknown tenant/slug -> not-found (4), rate
// limit / upstream / 5xx -> failure (1), invalid request -> usage (2).
export function mapGatewayError(err: unknown, ctx: { gatewayUrl: string; agent: string }): CliError {
  if (err instanceof CliError) return err
  if (err instanceof GatewayError) {
    if (err.status === 401) {
      return new CliError('unauthorized: the chat key is missing, invalid, revoked, or expired', ExitCode.Auth, [
        `Mint a fresh key with: orca agents keys create ${ctx.agent}`,
        'Pass it with --key or set ORCA_CHAT_KEY.',
      ])
    }
    if (err.status === 403) {
      return new CliError(
        'forbidden: this chat key is scoped to a different published agent or tenant',
        ExitCode.Auth,
        err.message ? [err.message] : undefined,
      )
    }
    if (err.status === 404) {
      return new CliError(
        `not found: no published agent for tenant/slug "${ctx.agent}"`,
        ExitCode.NotFound,
        err.message ? [err.message] : undefined,
      )
    }
    if (err.status === 429) {
      const wait = err.retryAfter ? `; retry after ${err.retryAfter}s` : ''
      return new CliError(`rate limited${wait}`, ExitCode.Failure)
    }
    if (err.status === 400) {
      return new CliError(`invalid request${err.message ? `: ${err.message}` : ''}`, ExitCode.Usage)
    }
    if (err.status >= 500) {
      return new CliError(
        `the gateway returned ${err.status}${err.message ? `: ${err.message}` : ''}; try again in a moment`,
        ExitCode.Failure,
      )
    }
    return new CliError(err.message || `gateway error ${err.status}`, ExitCode.Failure)
  }
  // fetch() rejects with TypeError when it cannot reach the host.
  if (err instanceof TypeError) {
    return new CliError(`cannot reach ${ctx.gatewayUrl}`, ExitCode.Failure, [
      'Check ORCA_GATEWAY_URL or the context gatewayUrl.',
    ])
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new CliError(`request to ${ctx.gatewayUrl} timed out`, ExitCode.Failure)
  }
  return err instanceof Error
    ? new CliError(err.message, ExitCode.Failure)
    : new CliError('unknown error', ExitCode.Failure)
}

// -- Client -------------------------------------------------------------------

export type GatewayClientOptions = {
  gatewayUrl: string
  tenant: string
  agent: string
  chatKey: string
}

// How a streamed turn ended:
//   done    - terminal success (message is the final assistant reply)
//   error   - terminal `error` SSE event (message/errorCode describe it)
//   dropped - stream closed with no terminal frame (network drop mid-run)
//   aborted - the caller's AbortSignal fired (Ctrl-C / turn cancel)
export type ChatTurnResult = {
  terminated: 'done' | 'error' | 'dropped' | 'aborted'
  message: string
  conversationId?: string
  publicRunId?: string
  errorCode?: string
}

export type StreamTurnOptions = {
  conversationId?: string
  endUserId?: string
  signal: AbortSignal
  // Raw SSE frames, for --json ndjson. Ping comment frames are included.
  onFrame?: (frame: GatewayFrame) => void
  // Normalized events, for rendering. Ping events are delivered too.
  onEvent?: (event: ChatEvent) => void
}

export class GatewayClient {
  readonly gatewayUrl: string
  readonly tenant: string
  readonly agent: string
  private readonly chatKey: string

  constructor(opts: GatewayClientOptions) {
    this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, '')
    this.tenant = opts.tenant
    this.agent = opts.agent
    this.chatKey = opts.chatKey
  }

  streamUrl(): string {
    return `${this.gatewayUrl}/v1/chat/${encodeURIComponent(this.tenant)}/${encodeURIComponent(this.agent)}/stream`
  }

  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.chatKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
  }

  // streamChat POSTs a turn and consumes the SSE stream to completion. It
  // throws GatewayError for HTTP-level rejections (before the stream opens);
  // a terminal `error` SSE event returns { terminated: 'error' } instead so
  // callers (e.g. the REPL) can keep going. No client-side idle timeout is
  // set: only the caller's signal ends the stream (the 30s stream-cut was a
  // server bug, fixed; do not re-add a short client timeout).
  async streamChat(message: string, opts: StreamTurnOptions): Promise<ChatTurnResult> {
    const body: Record<string, unknown> = { message }
    if (opts.conversationId) body.conversation_id = opts.conversationId
    if (opts.endUserId) body.metadata = { end_user_id: opts.endUserId }

    let res: Response
    try {
      res = await fetch(this.streamUrl(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: opts.signal,
      })
    } catch (err) {
      if (opts.signal.aborted) {
        return { terminated: 'aborted', message: '', conversationId: opts.conversationId }
      }
      throw err
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok || !contentType.includes('text/event-stream')) {
      let errBody: unknown
      try {
        errBody = await res.json()
      } catch {
        /* non-JSON error body */
      }
      const retryAfter = res.headers.get('Retry-After')
      throw new GatewayError(res.status, errBody, retryAfter ? Number(retryAfter) : undefined)
    }
    if (!res.body) throw new GatewayError(res.status, { error: 'upstream', message: 'empty stream body' })

    const decoder = new TextDecoder('utf-8')
    const buf = new GatewayStreamBuffer()
    let accum = ''
    let result: ChatTurnResult = { terminated: 'dropped', message: '', conversationId: opts.conversationId }

    const handle = (frame: GatewayFrame) => {
      opts.onFrame?.(frame)
      const ev = decodeFrame(frame)
      if (!ev) return
      switch (ev.type) {
        case 'delta':
          accum += ev.text
          break
        case 'done':
          result = {
            terminated: 'done',
            message: ev.message || accum,
            conversationId: ev.conversationId ?? result.conversationId,
            publicRunId: ev.publicRunId,
          }
          break
        case 'error':
          result = {
            terminated: 'error',
            message: ev.message,
            errorCode: ev.code,
            conversationId: result.conversationId,
            publicRunId: ev.publicRunId,
          }
          break
        case 'tool':
        case 'ping':
          break
      }
      opts.onEvent?.(ev)
    }

    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        for (const frame of buf.push(decoder.decode(chunk, { stream: true }))) handle(frame)
      }
      for (const frame of buf.push(decoder.decode())) handle(frame)
      const tail = buf.flush()
      if (tail) handle(tail)
    } catch {
      // Abort is intentional; any other read failure is a mid-run drop. Either
      // way the run keeps executing server-side; the caller decides what next.
      if (opts.signal.aborted) return { ...result, terminated: 'aborted', message: accum }
      return { ...result, terminated: 'dropped', message: accum }
    }

    if (result.terminated === 'dropped') result.message = accum
    return result
  }
}
