// Builds SSE Response bodies with adversarial chunk boundaries: frames are
// split mid-line and mid-multibyte-character to lock in decoder semantics.

export function sseFrames(events: unknown[], opts?: { pings?: boolean }): string {
  const frames: string[] = []
  events.forEach((e, i) => {
    if (opts?.pings && i > 0 && i % 2 === 0) frames.push(': ping\n\n')
    frames.push(`id: ${i}\ndata: ${JSON.stringify(e)}\n\n`)
  })
  return frames.join('')
}

// chunked splits raw text into byte chunks of the given sizes (repeating the
// last size), guaranteeing some multibyte characters straddle boundaries
// when sizes are odd.
export function chunkedBytes(raw: string, sizes: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(raw)
  const out: Uint8Array[] = []
  let offset = 0
  let i = 0
  while (offset < bytes.length) {
    const size = sizes[Math.min(i, sizes.length - 1)]
    out.push(bytes.slice(offset, offset + size))
    offset += size
    i++
  }
  return out
}

export function streamResponse(chunks: Uint8Array[], init?: { status?: number }): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
