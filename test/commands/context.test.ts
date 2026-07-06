import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerContext } from '../../src/commands/context.js'
import { loadConfig, saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program
    .exitOverride()
    .option('--context <name>')
    .option('--api-url <url>')
    .option('--json')
  registerContext(program)
  await program.parseAsync(args, { from: 'user' })
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  delete process.env.ORCA_API_KEY
  delete process.env.ORCA_API_URL
  delete process.env.ORCA_CONTEXT
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .join('')
}

describe('context list', () => {
  it('prints a plain marker row per context (non-TTY)', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: {
        default: { apiUrl: 'http://test:8080', apiKey: 'ao_dev_abcdefghijklmnopqrstuv' },
        prod: { apiUrl: 'https://prod.example' },
      },
    })
    await run(['context', 'list'])
    expect(stdout()).toBe(
      '*\tdefault\thttp://test:8080\tao_dev_...stuv\n' + '\tprod\thttps://prod.example\t-\n',
    )
  })

  it('emits raw context objects with --json', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080' } },
    })
    await run(['--json', 'context', 'list'])
    expect(JSON.parse(stdout())).toEqual([
      { name: 'default', current: true, apiUrl: 'http://test:8080', gatewayUrl: null, hasKey: false },
    ])
  })

  it('hints when no contexts are configured', async () => {
    await run(['context', 'list'])
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('orca auth login')
  })
})

describe('context use', () => {
  it('switches the current context', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080' }, prod: { apiUrl: 'https://prod.example' } },
    })
    await run(['context', 'use', 'prod'])
    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('prod')
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Switched to context "prod"')
  })

  it('fails for an unknown context', async () => {
    await saveConfig({ contexts: {} })
    await expect(run(['context', 'use', 'nope'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('context show', () => {
  it('prints plain label/value lines (non-TTY)', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: 'ao_dev_abcdefghijklmnopqrstuv' } },
    })
    await run(['context', 'show'])
    const out = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')
    expect(out).toContain('Context:  default')
    expect(out).toContain('API URL:  http://test:8080')
    expect(out).toContain('API key:  ao_dev_...stuv')
  })

  it('fails when the context has neither URL nor key', async () => {
    await saveConfig({ contexts: {} })
    await expect(run(['context', 'show'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})
