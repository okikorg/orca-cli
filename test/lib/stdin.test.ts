import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ isFile: false, contents: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    fstatSync: (fd: number) => (fd === 0 ? { isFile: () => fs.isFile } : real.fstatSync(fd)),
    readFileSync: (file: unknown, ...rest: unknown[]) =>
      file === 0 ? fs.contents : (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest),
  }
})

const { readStdin } = await import('../../src/lib/stdin.js')

describe('readStdin', () => {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
  afterEach(() => {
    Object.defineProperty(process, 'stdin', stdin)
    fs.isFile = false
  })

  function streamStdin(text: string): { iterated: () => boolean } {
    let iterated = false
    const stream = Readable.from([Buffer.from(text)])
    const iterate = stream[Symbol.asyncIterator].bind(stream)
    stream[Symbol.asyncIterator] = () => {
      iterated = true
      return iterate()
    }
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
    return { iterated: () => iterated }
  }

  // The Bun binary's process.stdin yields nothing for a file it has already
  // touched, so a heredoc or `< file` must be read from fd 0, not the stream.
  it('reads a regular file (a heredoc, or < file) from fd 0, not the stream', async () => {
    fs.isFile = true
    fs.contents = 'name: support\nmodel: orca/openrouter/openai/gpt-5.6-luna\n'
    const probe = streamStdin('')
    expect(await readStdin()).toBe(fs.contents)
    expect(probe.iterated()).toBe(false)
  })

  it('drains a pipe as a stream', async () => {
    const probe = streamStdin('hello from a pipe\n')
    expect(await readStdin()).toBe('hello from a pipe\n')
    expect(probe.iterated()).toBe(true)
  })
})

describe('readStdin in a real process', () => {
  const script = `import { readStdin } from ${JSON.stringify(path.resolve('src/lib/stdin.ts'))}; process.stdin.isTTY; await new Promise((r) => setTimeout(r, 20)); process.stdout.write(JSON.stringify(await readStdin()))`
  const run = (options: { input?: string; stdio?: [number, 'pipe', 'pipe'] }) =>
    JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { ...options, encoding: 'utf8' }))

  it('reads stdin redirected from a file', async () => {
    const file = path.join(os.tmpdir(), `orca-stdin-${process.pid}.yaml`)
    writeFileSync(file, 'name: from-a-file\n')
    const { openSync, closeSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const fd = openSync(file, 'r')
    try {
      expect(run({ stdio: [fd, 'pipe', 'pipe'] })).toBe('name: from-a-file\n')
    } finally {
      closeSync(fd)
    }
  })

  it('reads stdin from a pipe', () => {
    expect(run({ input: 'name: from-a-pipe\n' })).toBe('name: from-a-pipe\n')
  })
})
