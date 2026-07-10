import { EventEmitter } from 'node:events'

import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StoragePathEntry } from '../../src/lib/storage-paths.js'
import { StorageBrowser } from '../../src/ui/StorageBrowser.js'
import { glyphs } from '../../src/ui/theme.js'

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function ready(stdin: EventEmitter): Promise<void> {
  await waitFor(() => stdin.listenerCount('readable') > 0 || stdin.listenerCount('data') > 0)
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const entries: StoragePathEntry[] = [
  { key: 'runs/r1/out.txt', size: 42, lastModified: '2026-07-01T09:00:00Z' },
  { key: 'runs/readme.md', size: 20, lastModified: '2026-06-30T08:00:00Z' },
]

afterEach(cleanup)

describe('StorageBrowser', () => {
  it('loads and renders immediate folders before files', async () => {
    const load = vi.fn(async () => ({ entries, count: 2, truncated: false }))
    const { lastFrame } = render(<StorageBrowser initialPrefix="runs/" load={load} onExit={() => {}} />)
    await waitFor(() => (lastFrame() ?? '').includes('readme.md'))
    const frame = lastFrame() ?? ''
    expect(load).toHaveBeenCalledWith('runs/')
    expect(frame).toContain('Storage · /runs/')
    expect(frame).toContain('DIR')
    expect(frame).toContain('r1/')
    expect(frame.indexOf('r1/')).toBeLessThan(frame.indexOf('readme.md'))
  })

  it('enters a folder and returns to its parent', async () => {
    const load = vi.fn(async (prefix: string) => ({
      entries: prefix === 'runs/r1/' ? [entries[0]] : entries,
      count: prefix === 'runs/r1/' ? 1 : 2,
      truncated: false,
    }))
    const { stdin, lastFrame } = render(
      <StorageBrowser initialPrefix="runs/" load={load} onExit={() => {}} />,
    )
    await waitFor(() => (lastFrame() ?? '').includes('r1/'))
    await ready(stdin as unknown as EventEmitter)
    stdin.write('\r')
    await waitFor(() => (lastFrame() ?? '').includes('Storage · /runs/r1/'))
    stdin.write('\x1B[D')
    await waitFor(() => (lastFrame() ?? '').includes('Storage · /runs/'))
  })

  it('shows file details and returns to the directory', async () => {
    const load = async () => ({ entries, count: 2, truncated: false })
    const { stdin, lastFrame } = render(
      <StorageBrowser initialPrefix="runs/" load={load} onExit={() => {}} />,
    )
    await waitFor(() => (lastFrame() ?? '').includes('readme.md'))
    await ready(stdin as unknown as EventEmitter)
    stdin.write('\x1B[B')
    await waitFor(() =>
      (lastFrame() ?? '').split('\n').some((line) => line.includes(glyphs.pointer) && line.includes('readme.md')),
    )
    stdin.write('\r')
    await waitFor(() => (lastFrame() ?? '').includes('orca storage get runs/readme.md'))
    stdin.write('\x7f')
    await waitFor(() => (lastFrame() ?? '').includes('filter'))
  })

  it('filters entries and exits on escape', async () => {
    let exited = false
    const { stdin, lastFrame } = render(
      <StorageBrowser
        initialPrefix="runs/"
        load={async () => ({ entries, count: 2, truncated: false })}
        onExit={() => (exited = true)}
      />,
    )
    await waitFor(() => (lastFrame() ?? '').includes('readme.md'))
    await ready(stdin as unknown as EventEmitter)
    stdin.write('read')
    await waitFor(() => !(lastFrame() ?? '').includes('r1/'))
    expect(lastFrame() ?? '').toContain('readme.md')
    stdin.write('\x1B')
    await waitFor(() => exited)
  })
})
