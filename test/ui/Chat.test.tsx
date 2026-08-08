import { cleanup, render } from 'ink-testing-library'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import { Chat, type SendTurn } from '../../src/ui/Chat.js'
import type { ChatTurnResult } from '../../src/lib/gateway.js'
import { glyphs } from '../../src/ui/theme.js'

// Ink's first yoga layout can block the worker for hundreds of ms, so poll
// for a condition instead of sleeping a fixed interval.
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// Ink (v7) subscribes to stdin via the `readable` event once raw mode turns
// on (post first-commit). A keystroke written before that is dropped by the
// EventEmitter, so gate every interaction on the listener being present.
async function ready(stdin: EventEmitter): Promise<void> {
  await waitFor(() => stdin.listenerCount('readable') > 0 || stdin.listenerCount('data') > 0)
  // One extra tick so the useInput hooks have registered with Ink's dispatcher.
  await new Promise((r) => setTimeout(r, 20))
}

afterEach(() => {
  cleanup()
})

describe('Chat REPL', () => {
  it('renders the intro, a submitted turn with tool chips, and the assistant reply', async () => {
    const send: SendTurn = async (_message, handlers) => {
      handlers.onEvent({ type: 'tool', id: 't1', name: 'web_search', status: 'running' })
      // The gateway's completion event intentionally omits the tool name.
      handlers.onEvent({ type: 'tool', id: 't1', status: 'ok' })
      handlers.onEvent({ type: 'delta', text: 'Hi ' })
      handlers.onEvent({ type: 'delta', text: 'there' })
      return { terminated: 'done', message: 'Hi there', conversationId: 'conv_1' }
    }

    let exitCalled = false
    let exitConv: string | undefined
    const { stdin, frames } = render(
      <Chat
        agentLabel="support"
        send={send}
        onExit={(c) => {
          exitCalled = true
          exitConv = c
        }}
      />,
    )

    await waitFor(() => frames.join('').includes('Chat'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('hello')
    await waitFor(() => frames.join('\n').includes('hello'))
    stdin.write('\r')
    await waitFor(() => frames.join('\n').includes('Hi there'))

    const out = frames.join('\n')
    expect(out).toContain('you') // user turn has an explicit role
    expect(out).toContain(`${glyphs.pointer} hello`)
    expect(out).not.toContain('published agent')
    expect(out).toContain('stop or exit')
    expect(out).toContain('Researching') // tool activity is grouped by intent
    expect(out).toContain(`${glyphs.statusFilled} web_search`)
    expect(out).not.toContain('tool web_search')
    expect(out).not.toContain('tool tool')
    expect(out).not.toContain('web_search ok')
    expect(out).toContain('Hi there') // assistant reply committed to the transcript

    // Ctrl-C from idle exits cleanly, reporting the carried conversation id.
    stdin.write('\x03')
    await waitFor(() => exitCalled)
    expect(exitConv).toBe('conv_1')
  }, 20000)

  it('shows an active work phase and open status marker while a tool is running', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const send: SendTurn = async (_message, handlers) => {
      handlers.onEvent({ type: 'tool', id: 't1', name: 'mcp__runner__read_file', status: 'running' })
      await gate
      handlers.onEvent({ type: 'tool', id: 't1', status: 'ok' })
      return { terminated: 'done', message: 'Project read.' }
    }

    const { stdin, lastFrame } = render(<Chat agentLabel="support" send={send} onExit={() => {}} />)
    await waitFor(() => lastFrame()?.includes('Chat') ?? false)
    await ready(stdin as unknown as EventEmitter)
    stdin.write('read this project')
    await waitFor(() => lastFrame()?.includes('read this project') ?? false)
    stdin.write('\r')

    await waitFor(() => lastFrame()?.includes('read_file') ?? false)
    const live = lastFrame() ?? ''
    expect(live).toContain('Inspecting')
    expect(live).toContain(`${glyphs.statusOpen} read_file`)
    expect(live).toContain('working')

    release()
    await waitFor(() => lastFrame()?.includes('Project read.') ?? false)
  }, 20000)

  it('renders a gateway error turn but keeps the REPL alive', async () => {
    const send: SendTurn = async () =>
      ({ terminated: 'error', message: 'conductor failed mid-run' }) as ChatTurnResult

    let exitCalled = false
    const { stdin, frames } = render(<Chat agentLabel="support" send={send} onExit={() => (exitCalled = true)} />)

    await waitFor(() => frames.join('').includes('Chat'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('go')
    await waitFor(() => frames.join('\n').includes('go'))
    stdin.write('\r')
    await waitFor(() => frames.join('\n').includes('conductor failed mid-run'))
    expect(frames.join('\n')).toContain('error:')
    expect(exitCalled).toBe(false) // an error turn does not tear down the session
  }, 20000)

  it('cancels the in-flight turn on Ctrl-C without exiting, then exits on a second Ctrl-C', async () => {
    let aborted = false
    const send: SendTurn = (_message, handlers) =>
      new Promise<ChatTurnResult>((resolve) => {
        handlers.onEvent({ type: 'delta', text: 'thinking...' })
        handlers.signal.addEventListener('abort', () => {
          aborted = true
          resolve({ terminated: 'aborted', message: 'thinking...' })
        })
      })

    let exitCalled = false
    const { stdin, frames } = render(<Chat agentLabel="support" send={send} onExit={() => (exitCalled = true)} />)

    await waitFor(() => frames.join('').includes('Chat'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('go')
    await waitFor(() => frames.join('\n').includes('go'))
    stdin.write('\r')
    await waitFor(() => frames.join('\n').includes('thinking...'))

    stdin.write('\x03') // aborts the in-flight turn (synchronously), not the session
    await waitFor(() => aborted)
    await waitFor(() => frames.join('\n').includes('(cancelled)'))
    expect(exitCalled).toBe(false)

    stdin.write('\x03') // now idle: exits
    await waitFor(() => exitCalled)
    expect(exitCalled).toBe(true)
  }, 20000)
})
