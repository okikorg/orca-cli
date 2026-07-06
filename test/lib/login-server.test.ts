import { afterEach, describe, expect, it } from 'vitest'

import {
  LoginCancelledError,
  LoginTimeoutError,
  startLoginServer,
  type CallbackPayload,
  type LoginServer,
} from '../../src/lib/login-server.js'

const STATE = 'a'.repeat(64)
const ORIGIN = 'https://dash.example.com'

const servers: LoginServer[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function start(opts?: { timeoutMs?: number }): Promise<LoginServer> {
  const s = await startLoginServer({ state: STATE, allowOrigin: ORIGIN, timeoutMs: opts?.timeoutMs })
  servers.push(s)
  return s
}

// post simulates the browser page POSTing the callback. Uses the real global
// fetch against the loopback server (no fetch stubbing in this file).
async function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

// pendingWithin resolves to true if `p` is still pending after `ms`.
function pendingWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => false).catch(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), ms)),
  ])
}

describe('startLoginServer', () => {
  it('accepts a matching-state callback and resolves with the payload', async () => {
    const server = await start()
    const wait = server.waitForCallback()
    const res = await post(server.port, {
      state: STATE,
      key: 'ao_live_secret000000000000000000',
      keyId: 'key_123',
      role: 'admin',
      orgSlug: 'acme',
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })

    const payload = (await wait) as CallbackPayload
    expect(payload).toEqual({
      state: STATE,
      key: 'ao_live_secret000000000000000000',
      keyId: 'key_123',
      role: 'admin',
      orgSlug: 'acme',
    })
  })

  it('rejects a mismatched state (400) without resolving, then accepts the real one', async () => {
    const server = await start()
    const wait = server.waitForCallback()

    const bad = await post(server.port, { state: 'deadbeef', key: 'ao_x' })
    expect(bad.status).toBe(400)
    expect(await pendingWithin(wait, 60)).toBe(true)

    const good = await post(server.port, { state: STATE, key: 'ao_live_good0000000000000000000000' })
    expect(good.status).toBe(200)
    const payload = await wait
    expect(payload.key).toBe('ao_live_good0000000000000000000000')
  })

  it('rejects garbage (non-JSON and malformed) without resolving', async () => {
    const server = await start()
    const wait = server.waitForCallback()

    const notJson = await post(server.port, 'this is not json')
    expect(notJson.status).toBe(400)

    const missingFields = await post(server.port, { hello: 'world' })
    expect(missingFields.status).toBe(400)

    expect(await pendingWithin(wait, 60)).toBe(true)
  })

  it('answers the CORS preflight with the dashboard origin', async () => {
    const server = await start()
    const res = await fetch(`http://127.0.0.1:${server.port}/callback`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type')
    // Chrome blocks public-HTTPS-to-loopback requests without this.
    expect(res.headers.get('access-control-allow-private-network')).toBe('true')
  })

  it('is one-shot: stops listening after an accepted callback', async () => {
    const server = await start()
    const wait = server.waitForCallback()
    await post(server.port, { state: STATE, key: 'ao_live_oneshot0000000000000000000' })
    await wait
    // Give the server a beat to close after the response flushed.
    await new Promise((r) => setTimeout(r, 50))
    await expect(post(server.port, { state: STATE, key: 'ao_x' })).rejects.toBeInstanceOf(Error)
  })

  it('times out waiting for a callback', async () => {
    const server = await start({ timeoutMs: 40 })
    await expect(server.waitForCallback()).rejects.toBeInstanceOf(LoginTimeoutError)
  })

  it('rejects as cancelled when closed before a callback', async () => {
    const server = await start()
    const wait = server.waitForCallback()
    server.close()
    await expect(wait).rejects.toBeInstanceOf(LoginCancelledError)
  })
})
