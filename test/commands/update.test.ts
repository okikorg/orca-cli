import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerUpdate, type UpdateDeps } from '../../src/commands/update.js'
import { ExitCode } from '../../src/lib/errors.js'
import type { ReleaseInfo, UpdateEnv } from '../../src/lib/release.js'

const EXEC_PATH = '/home/u/.local/bin/orca'

function release(tag: string): ReleaseInfo {
  const version = tag.replace(/^cli-v/, '')
  return {
    tag,
    version,
    htmlUrl: `https://github.com/okikorg/orca-cli/releases/tag/${tag}`,
    assets: [
      { name: 'orca-darwin-arm64.tar.gz', url: `https://dl/${tag}/orca-darwin-arm64.tar.gz` },
      { name: 'SHA256SUMS', url: `https://dl/${tag}/SHA256SUMS` },
    ],
  }
}

const STANDALONE: UpdateEnv = { standalone: true, platform: 'darwin', arch: 'arm64', execPath: EXEC_PATH }

// Builds an injectable dep set; override any piece per test.
function deps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    env: () => STANDALONE,
    fetchLatest: async () => release('cli-v0.2.0'),
    fetchByTag: async (tag: string) => release(tag.startsWith('cli-v') ? tag : `cli-v${tag}`),
    performUpdate: async (rel, env) => ({ path: env.execPath, version: rel.version }),
    ...over,
  }
}

async function run(args: string[], d: UpdateDeps): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerUpdate(program, d)
  await program.parseAsync(args, { from: 'user' })
}

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .join('')
}

function logged(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((c) => c.map(String).join(' '))
    .join('\n')
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orca update', () => {
  it('performs the swap and confirms when a newer version exists', async () => {
    const performUpdate = vi.fn(deps().performUpdate)
    await run(['update'], deps({ performUpdate }))
    expect(performUpdate).toHaveBeenCalledOnce()
    expect(logged()).toContain('Updated')
    expect(logged()).toContain('cli-v0.2.0')
  })

  it('emits a machine-readable result with --json', async () => {
    await run(['--json', 'update'], deps())
    expect(JSON.parse(stdout())).toMatchObject({
      currentTag: 'cli-v0.1.0',
      latestTag: 'cli-v0.2.0',
      updateAvailable: true,
      updated: true,
      path: EXEC_PATH,
    })
  })

  it('does nothing when already on the latest version', async () => {
    const performUpdate = vi.fn(deps().performUpdate)
    await run(['update'], deps({ fetchLatest: async () => release('cli-v0.1.0'), performUpdate }))
    expect(performUpdate).not.toHaveBeenCalled()
    expect(logged()).toContain('Already on the latest')
  })

  it('reinstalls the current version under --force', async () => {
    const performUpdate = vi.fn(deps().performUpdate)
    await run(['update', '--force'], deps({ fetchLatest: async () => release('cli-v0.1.0'), performUpdate }))
    expect(performUpdate).toHaveBeenCalledOnce()
  })

  it('installs a pinned version via --tag', async () => {
    const fetchByTag = vi.fn(async (tag: string) => release(tag.startsWith('cli-v') ? tag : `cli-v${tag}`))
    const performUpdate = vi.fn(deps().performUpdate)
    await run(['update', '--tag', 'cli-v0.5.0'], deps({ fetchByTag, performUpdate }))
    expect(fetchByTag).toHaveBeenCalledWith('cli-v0.5.0')
    expect(performUpdate).toHaveBeenCalledOnce()
    expect(logged()).toContain('cli-v0.5.0')
  })

  it('--check reports without installing', async () => {
    const performUpdate = vi.fn(deps().performUpdate)
    await run(['update', '--check'], deps({ performUpdate }))
    expect(performUpdate).not.toHaveBeenCalled()
    expect(logged()).toContain('Update available')
  })

  it('--check --json emits the comparison only', async () => {
    await run(['--json', 'update', '--check'], deps())
    const out = JSON.parse(stdout())
    expect(out).toMatchObject({ updateAvailable: true, latestTag: 'cli-v0.2.0' })
    expect(out.updated).toBeUndefined()
  })

  it('gives guidance instead of swapping when not a standalone binary', async () => {
    const performUpdate = vi.fn(deps().performUpdate)
    const env = (): UpdateEnv => ({ ...STANDALONE, standalone: false })
    await run(['update'], deps({ env, performUpdate }))
    expect(performUpdate).not.toHaveBeenCalled()
    expect(logged()).toContain("can't self-update")
  })

  it('gives Windows guidance (a running .exe cannot replace itself)', async () => {
    const performUpdate = vi.fn(deps().performUpdate)
    const env = (): UpdateEnv => ({ standalone: true, platform: 'win32', arch: 'x64', execPath: 'C:/orca.exe' })
    await run(['update'], deps({ env, performUpdate }))
    expect(performUpdate).not.toHaveBeenCalled()
    expect(logged()).toContain('Windows')
  })

  it('maps a release-fetch failure to the Failure exit code', async () => {
    const d = deps({
      fetchLatest: async () => {
        throw new Error('network down')
      },
    })
    await expect(run(['update'], d)).rejects.toMatchObject({ exitCode: ExitCode.Failure })
  })

  it('maps a permission error during the swap to the Failure exit code', async () => {
    const d = deps({
      performUpdate: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
    })
    await expect(run(['update'], d)).rejects.toMatchObject({ exitCode: ExitCode.Failure })
  })
})
