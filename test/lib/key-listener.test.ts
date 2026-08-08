import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { listenForKeyPaste } from '../../src/lib/key-listener.js'

// FakeTty mimics the parts of a raw-capable TTY read stream the listener
// touches. Input is driven by emitting 'data' like a real terminal would.
class FakeTty extends EventEmitter {
  isTTY = true
  raw = false
  paused = false
  setRawMode(v: boolean): this {
    this.raw = v
    return this
  }
  resume(): this {
    this.paused = false
    return this
  }
  pause(): this {
    this.paused = true
    return this
  }
}

type FakeOut = { chunks: string[]; write: (s: string) => boolean }
function fakeOut(): FakeOut {
  const chunks: string[] = []
  return { chunks, write: (s: string) => (chunks.push(s), true) }
}

// pendingWithin resolves true if `p` is still pending after `ms`.
function pendingWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), ms)),
  ])
}

function arm(opts?: { prompt?: string; onFirstInput?: () => void; onCancel?: () => void }) {
  const input = new FakeTty()
  const out = fakeOut()
  const listener = listenForKeyPaste({
    input: input as unknown as NodeJS.ReadStream,
    output: out as unknown as NodeJS.WriteStream,
    ...opts,
  })
  if (!listener) throw new Error('listener should arm on a fake TTY')
  return { input, out, listener }
}

describe('listenForKeyPaste', () => {
  it('returns null when the input is not a raw-capable TTY', () => {
    const notTty = new FakeTty()
    notTty.isTTY = false
    expect(
      listenForKeyPaste({ input: notTty as unknown as NodeJS.ReadStream }),
    ).toBeNull()

    const noRaw = new EventEmitter() as unknown as NodeJS.ReadStream
    ;(noRaw as { isTTY: boolean }).isTTY = true
    expect(listenForKeyPaste({ input: noRaw })).toBeNull()
  })

  it('arms raw mode and resolves with a pasted key on Enter', async () => {
    const { input, listener } = arm()
    expect(input.raw).toBe(true)

    input.emit('data', Buffer.from('ao_live_abc123\r'))
    await expect(listener.promise).resolves.toBe('ao_live_abc123')
    expect(input.raw).toBe(false)
    expect(input.paused).toBe(true)
  })

  it('does not echo the pasted key or mask characters', async () => {
    const { input, out, listener } = arm()
    input.emit('data', 'ao_secret')
    input.emit('data', '\r')
    await listener.promise
    expect(out.chunks).toEqual([])
  })

  it('renders a stable prompt with one hidden marker, then clears it', async () => {
    const { input, out, listener } = arm({ prompt: '> Paste key: ' })
    expect(out.chunks.join('')).toContain('> Paste key: ')

    input.emit('data', 'ao_secret')
    expect(out.chunks.join('')).not.toContain('ao_secret')
    expect(out.chunks.join('')).toContain('> Paste key: [hidden]')
    expect(out.chunks.join('')).not.toContain('*********')

    input.emit('data', '\r')
    await expect(listener.promise).resolves.toBe('ao_secret')
    expect(out.chunks.at(-1)).toBe('\r\x1b[2K')
  })

  it('supports backspace editing before submit', async () => {
    const { input, listener } = arm()
    input.emit('data', 'ao_xz')
    input.emit('data', '\x7f')
    input.emit('data', 'y\r')
    await expect(listener.promise).resolves.toBe('ao_xy')
  })

  it('ignores Enter on an empty buffer', async () => {
    const { listener, input } = arm()
    input.emit('data', '\r')
    input.emit('data', '\n')
    expect(await pendingWithin(listener.promise, 40)).toBe(true)
  })

  it('fires onFirstInput exactly once while remaining silent', () => {
    let calls = 0
    const { input, out } = arm({ onFirstInput: () => calls++ })
    expect(out.chunks).toHaveLength(0)
    input.emit('data', 'a')
    input.emit('data', 'b')
    expect(calls).toBe(1)
    expect(out.chunks).toEqual([])
  })

  it('routes Ctrl-C to onCancel without resolving', async () => {
    let cancelled = false
    const { input, listener } = arm({ onCancel: () => (cancelled = true) })
    input.emit('data', 'ao_par')
    input.emit('data', '\x03')
    expect(cancelled).toBe(true)
    expect(input.raw).toBe(false)
    expect(await pendingWithin(listener.promise, 40)).toBe(true)
  })

  it('stop() detaches: later input is ignored and the promise stays pending', async () => {
    const { input, listener } = arm()
    listener.stop()
    expect(input.raw).toBe(false)
    input.emit('data', 'ao_live_late\r')
    expect(await pendingWithin(listener.promise, 40)).toBe(true)
    // Idempotent.
    listener.stop()
  })

  it('strips ANSI escape sequences from pasted input', async () => {
    const { input, listener } = arm()
    // Bracketed-paste markers around the key, plus a stray arrow key.
    input.emit('data', '\x1b[200~ao_live_esc\x1b[201~\x1b[A\r')
    await expect(listener.promise).resolves.toBe('ao_live_esc')
  })
})
