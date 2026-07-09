import { cleanup, render } from 'ink-testing-library'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import { Confirm } from '../../src/ui/Confirm.js'
import { glyphs } from '../../src/ui/theme.js'

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// useInput subscribes to stdin only after raw mode turns on (post first
// commit); gate interaction on the listener being present, plus one tick.
async function ready(stdin: EventEmitter): Promise<void> {
  await waitFor(() => stdin.listenerCount('readable') > 0 || stdin.listenerCount('data') > 0)
  await new Promise((r) => setTimeout(r, 20))
}

afterEach(() => {
  cleanup()
})

describe('Confirm', () => {
  it('renders the message with the coral pointer and a subtle (y/N)', async () => {
    const { lastFrame } = render(<Confirm message="Delete agent support-bot?" onDecision={() => {}} />)
    await waitFor(() => (lastFrame() ?? '').includes('Delete agent support-bot?'))

    const frame = lastFrame() ?? ''
    expect(frame).toContain(glyphs.pointer)
    expect(frame).toContain('Delete agent support-bot?')
    expect(frame).toContain('(y/N)')
  })

  it('confirms on y', async () => {
    let decision: boolean | undefined
    const { stdin, lastFrame } = render(<Confirm message="Proceed?" onDecision={(d) => (decision = d)} />)
    await waitFor(() => (lastFrame() ?? '').includes('Proceed?'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('y')
    await waitFor(() => decision !== undefined)
    expect(decision).toBe(true)
  })

  it('confirms on uppercase Y', async () => {
    let decision: boolean | undefined
    const { stdin, lastFrame } = render(<Confirm message="Proceed?" onDecision={(d) => (decision = d)} />)
    await waitFor(() => (lastFrame() ?? '').includes('Proceed?'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('Y')
    await waitFor(() => decision !== undefined)
    expect(decision).toBe(true)
  })

  it('declines on Enter (No is the default)', async () => {
    let decision: boolean | undefined
    const { stdin, lastFrame } = render(<Confirm message="Proceed?" onDecision={(d) => (decision = d)} />)
    await waitFor(() => (lastFrame() ?? '').includes('Proceed?'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('\r')
    await waitFor(() => decision !== undefined)
    expect(decision).toBe(false)
  })

  it('declines on any other key', async () => {
    let decision: boolean | undefined
    const { stdin, lastFrame } = render(<Confirm message="Proceed?" onDecision={(d) => (decision = d)} />)
    await waitFor(() => (lastFrame() ?? '').includes('Proceed?'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('n')
    await waitFor(() => decision !== undefined)
    expect(decision).toBe(false)
  })
})
