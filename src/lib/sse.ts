// SSE consumption for GET /api/runs/{id}/stream, ported from
// dashboard/src/lib/sse.ts. The endpoint replays buffered events on
// subscribe then follows with live events, closing when the run reaches a
// terminal status. Heartbeats arrive as ": ping" comment frames.

import { ApiClient, ApiError } from './api.js'
import type { RunEvent, RunStatus } from './types.js'

// SSEBuffer accumulates raw text across chunk boundaries and yields the
// data payload of each complete event block (blocks are terminated by a
// blank line). Comment lines are dropped; multi-line data is joined.
export class SSEBuffer {
  private buf = ''

  push(text: string): string[] {
    this.buf += text
    const out: string[] = []
    let boundary: number
    while ((boundary = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, boundary)
      this.buf = this.buf.slice(boundary + 2)
      const data = parseBlock(block)
      if (data !== null) out.push(data)
    }
    return out
  }

  // flush drains whatever remains after the stream closes (a final block
  // without the trailing blank line).
  flush(): string | null {
    const block = this.buf
    this.buf = ''
    return block.trim() ? parseBlock(block) : null
  }
}

function parseBlock(block: string): string | null {
  const dataParts: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).replace(/^ /, ''))
    }
    // Other fields (event:, id:, retry:) are ignored, matching the dashboard.
  }
  const data = dataParts.join('\n')
  return data ? data : null
}

export function decodeRunEvent(data: string): RunEvent {
  try {
    return JSON.parse(data) as RunEvent
  } catch {
    // Non-JSON fragment: preserve it as a progress message.
    return { type: 'progress', message: data }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

// streamRunEvents tails a run until it reaches a terminal status, delivering
// each RunEvent to onEvent exactly once across reconnects (the replay buffer
// is skipped by count). Returns the final status, or 'running' when the
// caller aborted. HTTP-level rejections (401, 404, ...) throw ApiError.
export async function streamRunEvents(
  client: ApiClient,
  runId: string,
  onEvent: (event: RunEvent) => void,
  opts: { signal: AbortSignal },
): Promise<RunStatus> {
  let delivered = 0
  let attempt = 0

  for (;;) {
    if (opts.signal.aborted) return 'running'
    let skip = attempt === 0 ? 0 : delivered

    try {
      const res = await fetch(client.url(`/api/runs/${encodeURIComponent(runId)}/stream`), {
        headers: client.headers({ Accept: 'text/event-stream' }),
        signal: opts.signal,
      })
      if (!res.ok) {
        let body: unknown
        try {
          body = await res.json()
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(`${res.status} ${res.statusText}`, res.status, body)
      }
      if (!res.body) throw new Error('stream response had no body')

      const decoder = new TextDecoder('utf-8')
      const sse = new SSEBuffer()
      const deliver = (data: string) => {
        if (skip > 0) {
          skip--
          return
        }
        delivered++
        onEvent(decodeRunEvent(data))
      }
      for await (const chunk of res.body) {
        for (const data of sse.push(decoder.decode(chunk as Uint8Array, { stream: true }))) {
          deliver(data)
        }
      }
      for (const data of sse.push(decoder.decode())) deliver(data)
      const tail = sse.flush()
      if (tail !== null) deliver(tail)
    } catch (err) {
      if (opts.signal.aborted) return 'running'
      // A rejected subscription (bad key, unknown run) is fatal; a dropped
      // connection falls through to the status probe and reconnects.
      if (err instanceof ApiError) throw err
    }

    if (opts.signal.aborted) return 'running'
    const run = await client.getRun(runId)
    if (run.status !== 'running') return run.status

    attempt++
    await sleep(Math.min(1000 * attempt, 5000), opts.signal)
  }
}
