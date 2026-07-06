// Localhost callback server for the browser login flow (orca auth login).
//
// The CLI binds an ephemeral 127.0.0.1 port and opens the dashboard's
// /cli-auth page pointed at that port. After the user authorizes, the
// dashboard mints a tenant API key and POSTs it back here as JSON. The
// server accepts exactly one callback whose `state` matches the value the
// CLI generated, replies 200 so the page can say "return to your terminal",
// then shuts down.
//
// This module is deliberately free of Ink/React and any CLI-output concerns
// so it can be unit-tested by driving it with a plain HTTP client that poses
// as the browser page.

import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'

// CallbackPayload is the JSON body the dashboard page POSTs to /callback.
// `state` is echoed back for anti-CSRF binding; `key` is the plaintext
// tenant API key (shown once, never logged); the rest is metadata used only
// for the CLI's success line and later revoke.
export type CallbackPayload = {
  state: string
  key: string
  keyId?: string
  role?: string
  orgSlug?: string | null
}

// LoginTimeoutError is thrown by waitForCallback when no matching callback
// arrives within the timeout. The command turns this into the paste fallback.
export class LoginTimeoutError extends Error {
  constructor() {
    super('timed out waiting for browser authorization')
    this.name = 'LoginTimeoutError'
  }
}

// LoginCancelledError is thrown by waitForCallback when close() is called
// before a callback arrives (e.g. Ctrl-C). Maps to exit code 130.
export class LoginCancelledError extends Error {
  constructor() {
    super('login cancelled')
    this.name = 'LoginCancelledError'
  }
}

export type LoginServer = {
  // The bound ephemeral port on 127.0.0.1.
  port: number
  // Resolves with the first callback whose state matches; rejects with
  // LoginTimeoutError or LoginCancelledError.
  waitForCallback: () => Promise<CallbackPayload>
  // Idempotent shutdown; rejects a pending waitForCallback as cancelled.
  close: () => void
}

// Cap the callback body so a stray/hostile local POST can't stream unbounded
// data into memory. A minted key + metadata is well under this.
const MAX_BODY_BYTES = 64 * 1024

// startLoginServer binds 127.0.0.1:0 and returns a handle. allowOrigin is the
// dashboard origin, echoed in the CORS headers so the (cross-origin) page can
// read the callback response; timeoutMs defaults to five minutes.
export async function startLoginServer(opts: {
  state: string
  allowOrigin: string
  timeoutMs?: number
}): Promise<LoginServer> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000

  // Outcome is single-shot: the first of {callback, timeout, close} wins.
  let done = false
  let bufferedPayload: CallbackPayload | null = null
  let bufferedError: Error | null = null
  let waiter: { resolve: (p: CallbackPayload) => void; reject: (e: Error) => void } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const setCors = (res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', opts.allowOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Access-Control-Max-Age', '600')
    // Chrome Private Network Access / Local Network Access: a public HTTPS
    // page fetching a loopback address must get this on the preflight or the
    // browser blocks the request outright.
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }

  const closeServer = () => {
    if (closed) return
    closed = true
    try {
      server.close()
    } catch {
      // Already closing; nothing to do.
    }
  }

  const settleWithPayload = (payload: CallbackPayload) => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    if (waiter) waiter.resolve(payload)
    else bufferedPayload = payload
  }

  const settleWithError = (err: Error) => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    if (waiter) waiter.reject(err)
    else bufferedError = err
    closeServer()
  }

  const server = createServer((req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'POST' || url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    let body = ''
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      body += chunk.toString('utf8')
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' }))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid json' }))
        return
      }
      const p = parsed as Partial<CallbackPayload> | null
      if (!p || typeof p !== 'object' || typeof p.state !== 'string' || typeof p.key !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'malformed payload' }))
        return
      }
      // State mismatch is rejected but the server keeps listening: a stray or
      // hostile POST that guesses the port still cannot guess the state, and
      // must not be able to abort the legitimate flow.
      if (p.state !== opts.state) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'state mismatch' }))
        return
      }
      // Already delivered a callback: acknowledge idempotently, do nothing.
      if (done) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      const payload: CallbackPayload = {
        state: p.state,
        key: p.key,
        keyId: typeof p.keyId === 'string' ? p.keyId : undefined,
        role: typeof p.role === 'string' ? p.role : undefined,
        orgSlug:
          typeof p.orgSlug === 'string' ? p.orgSlug : p.orgSlug === null ? null : undefined,
      }
      // Close only after the response has flushed so the browser reliably
      // gets its 200 before the socket goes away.
      res.on('finish', closeServer)
      settleWithPayload(payload)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0

  const waitForCallback = () =>
    new Promise<CallbackPayload>((resolve, reject) => {
      if (bufferedPayload) {
        resolve(bufferedPayload)
        return
      }
      if (bufferedError) {
        reject(bufferedError)
        return
      }
      waiter = { resolve, reject }
      timer = setTimeout(() => settleWithError(new LoginTimeoutError()), timeoutMs)
      // Don't keep the event loop alive purely for the timeout.
      if (typeof timer.unref === 'function') timer.unref()
    })

  const close = () => {
    settleWithError(new LoginCancelledError())
    closeServer()
  }

  return { port, waitForCallback, close }
}

// -- Browser launcher ---------------------------------------------------------

export type BrowserOpener = (url: string) => void

function defaultOpener(url: string): void {
  try {
    let cmd: string
    let args: string[]
    if (process.platform === 'darwin') {
      cmd = 'open'
      args = [url]
    } else if (process.platform === 'win32') {
      cmd = 'cmd'
      args = ['/c', 'start', '', url]
    } else {
      cmd = 'xdg-open'
      args = [url]
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // Launch is best-effort; the command always prints the URL as a fallback.
  }
}

let opener: BrowserOpener = defaultOpener

// setBrowserOpener swaps the launcher. Exposed only so unit tests can drive
// the login flow without actually spawning a browser; production code never
// calls this. Passing null restores the platform default.
export function setBrowserOpener(next: BrowserOpener | null): void {
  opener = next ?? defaultOpener
}

// openBrowser launches the user's default browser at the given URL, detached
// so the CLI keeps running. Failures are swallowed: the caller prints the URL.
export function openBrowser(url: string): void {
  opener(url)
}
