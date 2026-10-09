import { cleanup, render } from 'ink-testing-library'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import { Chat, type SendTurn, type Switcher } from '../../src/ui/Chat.js'
import type { ChatTurnResult } from '../../src/lib/sessions.js'
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
      // A completion event without the tool name keeps the running one's.
      handlers.onEvent({ type: 'tool', id: 't1', status: 'ok' })
      handlers.onEvent({ type: 'delta', text: 'Hi ' })
      handlers.onEvent({ type: 'delta', text: 'there' })
      return { terminated: 'done', message: 'Hi there', sessionId: 'sess_1' }
    }

    let exitCalled = false
    let exitSession: string | undefined
    const { stdin, frames } = render(
      <Chat
        agentLabel="support"
        send={send}
        onExit={(c) => {
          exitCalled = true
          exitSession = c
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
    expect(out).toContain('stop or exit')
    expect(out).toContain('Researching') // tool activity is grouped by intent
    expect(out).toContain(`${glyphs.statusFilled} web_search`)
    expect(out).not.toContain('tool web_search')
    expect(out).not.toContain('tool tool')
    expect(out).not.toContain('web_search ok')
    expect(out).toContain('Hi there') // assistant reply committed to the transcript

    // Ctrl-C from idle exits cleanly, reporting the session the turn ran in.
    stdin.write('\x03')
    await waitFor(() => exitCalled)
    expect(exitSession).toBe('sess_1')
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

  it('renders a failed turn but keeps the REPL alive', async () => {
    const send: SendTurn = async () =>
      ({ terminated: 'error', message: 'the turn failed mid-run' }) as ChatTurnResult

    let exitCalled = false
    const { stdin, frames } = render(<Chat agentLabel="support" send={send} onExit={() => (exitCalled = true)} />)

    await waitFor(() => frames.join('').includes('Chat'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('go')
    await waitFor(() => frames.join('\n').includes('go'))
    stdin.write('\r')
    await waitFor(() => frames.join('\n').includes('the turn failed mid-run'))
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

  it('after a credit runs out, asks with the warning, switches on the chosen model and continues', async () => {
    const sent: string[] = []
    const send: SendTurn = async (message) => {
      sent.push(message)
      if (sent.length === 1) {
        return {
          terminated: 'error',
          message: 'Out of Orca credit',
          errorCode: 'usage_limit_exceeded',
          errorParam: 'orca_credit',
          sessionId: 'sess_1',
        }
      }
      return { terminated: 'done', message: 'Continuing on your key', sessionId: 'sess_1' }
    }
    const applied: Array<[string, string]> = []
    const switcher: Switcher = {
      load: async () => ({
        items: [
          { label: 'anthropic/claude-sonnet-4-5', value: 'anthropic/claude-sonnet-4-5', detail: 'Anthropic, billed by your provider' },
          { label: 'openrouter/openai/gpt-5.6-luna', value: 'openrouter/openai/gpt-5.6-luna', detail: 'OpenRouter, billed by your provider' },
        ],
        // The same OpenRouter model is preselected.
        initial: 'openrouter/openai/gpt-5.6-luna',
        provider: 'orca',
      }),
      apply: async (sessionId, model) => {
        applied.push([sessionId, model])
      },
    }
    const { stdin, frames, lastFrame } = render(<Chat agentLabel="support" send={send} switcher={switcher} onExit={() => {}} />)
    await waitFor(() => frames.join('').includes('Chat'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('go')
    await waitFor(() => frames.join('\n').includes('go'))
    stdin.write('\r')
    await waitFor(() => (lastFrame() ?? '').includes('Top up, or switch this session?'))
    const asked = lastFrame() ?? ''
    expect(asked).toContain('Out of Orca credit')
    expect(asked).toContain("Switching may re-send this conversation without the provider's cache")
    expect(asked).toContain('Switch this session to your own key')

    // The first row is the switch.
    await ready(stdin as unknown as EventEmitter)
    stdin.write('\r')
    await waitFor(() => (lastFrame() ?? '').includes('Select a model'))
    await ready(stdin as unknown as EventEmitter)
    // Enter takes the preselected row.
    stdin.write('\r')
    await waitFor(() => frames.join('\n').includes('Continuing on your key'))
    expect(applied).toEqual([['sess_1', 'openrouter/openai/gpt-5.6-luna']])
    expect(sent).toEqual(['go', 'Continue'])
    expect(frames.join('\n')).toContain("Switched: this session's next turn runs on openrouter/openai/gpt-5.6-luna.")
  }, 20000)

  it('reports a credit out without asking when no switch is offered', async () => {
    const send: SendTurn = async () => ({
      terminated: 'error',
      message: 'Your OpenAI account is out of quota',
      errorCode: 'usage_limit_exceeded',
      errorParam: 'provider_quota',
      sessionId: 'sess_1',
    })
    const { stdin, frames, lastFrame } = render(<Chat agentLabel="support" send={send} onExit={() => {}} />)
    await waitFor(() => frames.join('').includes('Chat'))
    await ready(stdin as unknown as EventEmitter)
    stdin.write('go')
    await waitFor(() => frames.join('\n').includes('go'))
    stdin.write('\r')
    await waitFor(() => frames.join('\n').includes('out of quota'))
    expect(lastFrame() ?? '').not.toContain('Top up, or switch')
  }, 20000)

  it('after a message refused at admission for Orca credit, switches and sends that message again', async () => {
    const sent: string[] = []
    const send: SendTurn = async (message) => {
      sent.push(message)
      if (sent.length === 1) {
        return { terminated: 'error', message: '429: Out of Orca credit', errorCode: 'insufficient_quota', sessionId: 'sess_1' }
      }
      return { terminated: 'done', message: 'Answered on your key', sessionId: 'sess_1' }
    }
    const switcher: Switcher = {
      load: async () => ({ items: [{ label: 'anthropic/claude-sonnet-4-5', value: 'anthropic/claude-sonnet-4-5' }], provider: 'orca' }),
      apply: async () => {},
    }
    const { stdin, frames, lastFrame } = render(<Chat agentLabel="support" send={send} switcher={switcher} onExit={() => {}} />)
    await waitFor(() => frames.join('').includes('Chat'))
    await ready(stdin as unknown as EventEmitter)
    stdin.write('summarize the tickets')
    await waitFor(() => frames.join('\n').includes('summarize the tickets'))
    stdin.write('\r')
    await waitFor(() => (lastFrame() ?? '').includes('Top up, or switch this session?'))
    await ready(stdin as unknown as EventEmitter)
    stdin.write('\r')
    await waitFor(() => (lastFrame() ?? '').includes('Select a model'))
    await ready(stdin as unknown as EventEmitter)
    stdin.write('\r')
    await waitFor(() => frames.join('\n').includes('Answered on your key'))
    expect(sent).toEqual(['summarize the tickets', 'summarize the tickets'])
  }, 20000)
})
