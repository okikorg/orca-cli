// Raw-mode stdin listener used during the browser login wait. Some browsers
// (Safari always; Chromium forks that auto-deny the Local Network Access
// permission) cannot POST the minted key to the CLI's loopback server. The
// dashboard then falls back to showing the key on screen, so the terminal
// must accept a paste at any moment while the handshake is still pending,
// not only after the timeout.
//
// The listener can render a stable paste prompt while collecting input and
// resolves with the submitted key on Enter. Input is represented by one fixed
// "[hidden]" marker so a pasted credential never produces a long animated row
// of mask characters in the browser-login flow.

const MAX_KEY_CHARS = 512

// Strips ANSI escape sequences (arrow keys, bracketed-paste markers) so they
// never pollute the key buffer.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z~]/g

export type KeyPasteListener = {
  // Resolves with the trimmed key when the user pastes/types one and presses
  // Enter. Never settles after stop().
  promise: Promise<string>
  // Idempotent teardown: restores cooked mode and detaches from the stream.
  stop: () => void
}

// listenForKeyPaste arms the listener, or returns null when the input stream
// is not a raw-capable TTY (CI, pipes, test runners) so callers can skip the
// race entirely.
export function listenForKeyPaste(opts?: {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  // Optional stable prompt shown while the listener is armed.
  prompt?: string
  // Fired once on the first printable character. Callers use it to clear their
  // own progress output (the elapsed ticker).
  onFirstInput?: () => void
  // Fired on Ctrl-C, which raw mode swallows instead of raising SIGINT.
  onCancel?: () => void
}): KeyPasteListener | null {
  const input = opts?.input ?? process.stdin
  const output = opts?.output ?? process.stderr
  if (!input.isTTY || typeof input.setRawMode !== 'function') return null

  let buf = ''
  let started = false
  let stopped = false
  let promptVisible = false
  let resolveKey: ((key: string) => void) | null = null
  const promise = new Promise<string>((resolve) => {
    resolveKey = resolve
  })

  const redrawPrompt = () => {
    if (!opts?.prompt) return
    promptVisible = true
    output.write(`\r\x1b[2K${opts.prompt}${buf ? '[hidden]' : ''}`)
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    input.off('data', onData)
    try {
      input.setRawMode?.(false)
    } catch {
      // The stream may already be closed; cooked mode no longer matters.
    }
    input.pause()
    if (promptVisible) {
      output.write('\r\x1b[2K')
      promptVisible = false
    }
  }

  const onData = (chunk: Buffer | string) => {
    const text = chunk.toString('utf8').replace(ANSI_RE, '')
    for (const ch of text) {
      if (stopped) return
      if (ch === '\x03') {
        // Ctrl-C: raw mode means no SIGINT is delivered, so surface it here.
        stop()
        output.write('\n')
        opts?.onCancel?.()
        return
      }
      if (ch === '\r' || ch === '\n') {
        const key = buf.trim()
        if (!key) continue
        stop()
        resolveKey?.(key)
        return
      }
      if (ch === '\x7f' || ch === '\b') {
        const hadInput = buf.length > 0
        buf = buf.slice(0, -1)
        if (hadInput && buf.length === 0) redrawPrompt()
        continue
      }
      if (ch === '\x15') {
        // Ctrl-U clears the line, matching shell muscle memory.
        buf = ''
        redrawPrompt()
        continue
      }
      const code = ch.charCodeAt(0)
      if (code < 32 || code === 127) continue
      if (buf.length >= MAX_KEY_CHARS) continue
      if (!started) {
        started = true
        opts?.onFirstInput?.()
      }
      buf += ch
      if (buf.length === 1) redrawPrompt()
    }
  }

  input.setRawMode(true)
  input.resume()
  input.on('data', onData)
  redrawPrompt()

  return { promise, stop }
}
