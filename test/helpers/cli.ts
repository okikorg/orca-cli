import { Command } from 'commander'
import { afterEach, beforeEach, vi } from 'vitest'

import { saveConfig } from '../../src/lib/config.js'
import { useTmpConfigDir } from './tmp-config.js'

export const KEY = 'orca_sk_' + 'a'.repeat(52)
export const API = 'http://test:8080'

// commandHarness wires the shared setup for a command test file: a
// throwaway config logged in to API with KEY, captured stdout/stderr and
// console, and fetch/env stubs undone after each test. It returns `run`,
// which parses argv against a fresh program carrying the CLI's global flags
// and the given command groups, plus readers for what was printed.
export function commandHarness(...registers: ((program: Command) => void)[]) {
  let cleanup: () => Promise<void>
  const out: string[] = []
  const err: string[] = []

  beforeEach(async () => {
    out.length = 0
    err.length = 0
    const tmp = await useTmpConfigDir()
    cleanup = tmp.cleanup
    delete process.env.ORCA_API_KEY
    delete process.env.ORCA_API_URL
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: API, apiKey: KEY } } })
    vi.stubEnv('NO_COLOR', '1')
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      out.push(String(s))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      err.push(String(s))
      return true
    })
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(' ') + '\n')
    })
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      err.push(a.map(String).join(' ') + '\n')
    })
  })

  afterEach(async () => {
    await cleanup()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  return {
    run: async (args: string[]): Promise<void> => {
      const program = new Command()
      program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
      for (const register of registers) register(program)
      await program.parseAsync(args, { from: 'user' })
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

// list wraps rows in the server's list envelope.
export function list<T extends { id?: string | null }>(data: T[], hasMore = false) {
  return {
    object: 'list',
    data,
    has_more: hasMore,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  }
}
