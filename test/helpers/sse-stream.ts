// Builds SSE Response bodies with adversarial chunk boundaries: frames are
// split mid-line and mid-multibyte-character to lock in decoder semantics.

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
