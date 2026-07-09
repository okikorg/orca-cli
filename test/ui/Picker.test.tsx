import { cleanup, render } from 'ink-testing-library'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import { Picker, type PickerItem } from '../../src/ui/Picker.js'
import { glyphs } from '../../src/ui/theme.js'

// Ink's first yoga layout can block the worker for hundreds of ms, so poll for
// a condition instead of sleeping a fixed interval.
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// useInput subscribes to stdin only after raw mode turns on (post first
// commit). A keystroke written before that is dropped, so gate interaction on
// the listener being present, then one extra tick for the hook to register.
async function ready(stdin: EventEmitter): Promise<void> {
  await waitFor(() => stdin.listenerCount('readable') > 0 || stdin.listenerCount('data') > 0)
  await new Promise((r) => setTimeout(r, 20))
}

const items: PickerItem[] = [
  { label: 'support-bot', value: 'support-bot', detail: 'run_1 · running' },
  { label: 'sales-bot', value: 'sales-bot' },
  { label: 'triage', value: 'triage' },
]

afterEach(() => {
  cleanup()
})

describe('Picker', () => {
  it('renders every item with the pointer on the first row and a match count', async () => {
    const { lastFrame } = render(<Picker items={items} onSubmit={() => {}} onCancel={() => {}} />)
    await waitFor(() => (lastFrame() ?? '').includes('support-bot'))

    const frame = lastFrame() ?? ''
    expect(frame).toContain('support-bot')
    expect(frame).toContain('sales-bot')
    expect(frame).toContain('triage')
    // Detail metadata rides subtly after the label.
    expect(frame).toContain('run_1 · running')
    // A match count teaches the size of the list.
    expect(frame).toContain('3 matches')
    // The pointer glyph is present (on the active row / prompt).
    expect(frame).toContain(glyphs.pointer)
  })

  it('filters as you type and narrows the match count', async () => {
    const { stdin, lastFrame } = render(<Picker items={items} onSubmit={() => {}} onCancel={() => {}} />)
    await waitFor(() => (lastFrame() ?? '').includes('triage'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('bot')
    await waitFor(() => !(lastFrame() ?? '').includes('triage'))

    const frame = lastFrame() ?? ''
    expect(frame).toContain('support-bot')
    expect(frame).toContain('sales-bot')
    expect(frame).not.toContain('triage')
    // Filtered count reports "of N" against the full set.
    expect(frame).toContain('2 matches of 3')
  })

  it('submits the value under the pointer, moved by the arrow keys', async () => {
    let picked: string | undefined
    const { stdin, lastFrame } = render(
      <Picker items={items} onSubmit={(v) => (picked = v)} onCancel={() => {}} />,
    )
    await waitFor(() => (lastFrame() ?? '').includes('triage'))
    await ready(stdin as unknown as EventEmitter)

    // Move down one row and let the re-render commit before submitting, so the
    // enter handler closes over the updated cursor rather than a stale one.
    stdin.write('\x1B[B') // down arrow -> second row
    await waitFor(() => {
      const rows = (lastFrame() ?? '').split('\n')
      const salesRow = rows.find((r) => r.includes('sales-bot')) ?? ''
      return salesRow.trimStart().startsWith(glyphs.pointer)
    })
    stdin.write('\r') // enter
    await waitFor(() => picked !== undefined)
    expect(picked).toBe('sales-bot')
  })

  it('cancels on escape without submitting', async () => {
    let cancelled = false
    let picked: string | undefined
    const { stdin, lastFrame } = render(
      <Picker items={items} onSubmit={(v) => (picked = v)} onCancel={() => (cancelled = true)} />,
    )
    await waitFor(() => (lastFrame() ?? '').includes('triage'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('\x1B') // escape
    await waitFor(() => cancelled)
    expect(cancelled).toBe(true)
    expect(picked).toBeUndefined()
  })

  it('does not submit when the filter matches nothing', async () => {
    let picked: string | undefined
    const { stdin, lastFrame } = render(
      <Picker items={items} onSubmit={(v) => (picked = v)} onCancel={() => {}} />,
    )
    await waitFor(() => (lastFrame() ?? '').includes('triage'))
    await ready(stdin as unknown as EventEmitter)

    stdin.write('zzz')
    await waitFor(() => (lastFrame() ?? '').includes('0 matches'))
    stdin.write('\r') // enter with no match -> no-op
    // Give the handler a beat; picked must stay undefined.
    await new Promise((r) => setTimeout(r, 40))
    expect(picked).toBeUndefined()
  })
})
