import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { RunTail } from '../../src/ui/RunTail.js'
import { glyphs } from '../../src/ui/theme.js'
import type { RunEvent, RunStatus } from '../../src/lib/types.js'

function subscribeWith(events: RunEvent[], final: RunStatus) {
  return async (onEvent: (e: RunEvent) => void): Promise<RunStatus> => {
    for (const e of events) onEvent(e)
    await new Promise((r) => setTimeout(r, 10))
    return final
  }
}

// Ink's first yoga layout can block the worker for hundreds of ms, so poll
// for completion instead of sleeping a fixed interval.
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('RunTail', () => {
  it('renders each event type and the terminal summary', async () => {
    const events: RunEvent[] = [
      { type: 'assistant', message: 'thinking about it' },
      { type: 'tool_call', toolName: 'web_search', input: { q: 'orca' } },
      { type: 'tool_result', output: 'found it' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } },
      { type: 'result', message: 'all done' },
    ]
    let done: RunStatus | null = null
    const { frames } = render(
      <RunTail
        runId="run_1"
        subscribe={subscribeWith(events, 'ok')}
        onDone={(s) => {
          done = s
        }}
      />,
    )
    await waitFor(() => done !== null)
    // Log lines and the summary live in <Static>, so they appear in the
    // stream of frames and persist in scrollback after exit.
    const output = frames.join('\n')
    expect(output).toContain('thinking about it')
    // Tool calls hang off a tree glyph: `  <treeLast> tool web_search {...}`.
    expect(output).toContain(`${glyphs.treeLast} tool web_search`)
    expect(output).toContain('found it')
    expect(output).toContain('all done')
    // Terminal summary: status glyph + word, then a separator-joined trailer.
    expect(output).toContain(`${glyphs.statusFilled} ok`)
    expect(output).toContain(`run_1 ${glyphs.separator}`)
    expect(output).toContain('in 100 out 20')
    expect(done).toBe('ok')
  })

  it('shows the error status in the summary line', async () => {
    let done: RunStatus | null = null
    const { frames } = render(
      <RunTail
        runId="run_2"
        subscribe={subscribeWith([{ type: 'error', message: 'exploded' }], 'error')}
        onDone={(s) => {
          done = s
        }}
      />,
    )
    await waitFor(() => done !== null)
    const output = frames.join('\n')
    expect(output).toContain('error: exploded')
    // Terminal summary carries the status glyph + word.
    expect(output).toContain(`${glyphs.statusFilled} error`)
    expect(output).toContain('run_2')
    expect(done).toBe('error')
  })

  it('renders the streaming footer with a pulse spinner while live', async () => {
    // Hold the stream open so the dynamic footer is guaranteed to render at
    // least once before the summary replaces it.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let done: RunStatus | null = null
    const { frames, lastFrame } = render(
      <RunTail
        runId="run_3"
        subscribe={async () => {
          await gate
          return 'ok'
        }}
        onDone={(s) => {
          done = s
        }}
      />,
    )
    await waitFor(() => lastFrame()?.includes('streaming') ?? false)
    // The footer is a pulse spinner frame + bold `streaming` + subtle trailer.
    const live = frames.join('\n')
    expect(live).toContain('streaming')
    expect(live).toContain('run_3')
    expect(glyphs.spinner.some((f) => live.includes(f))).toBe(true)
    release()
    await waitFor(() => done !== null)
    expect(done).toBe('ok')
  })
})
