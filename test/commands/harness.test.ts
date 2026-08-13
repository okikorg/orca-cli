import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

// docker is mocked wholesale: these tests are about the command's chain of
// steps and its error handling, not about docker. lib/docker.test.ts covers
// the argv that would actually be run.
const docker = vi.hoisted(() => ({
  dockerAvailable: vi.fn(async () => true),
  build: vi.fn(async () => undefined),
  push: vi.fn(async () => undefined),
  resolveDigest: vi.fn(async () => `ghcr.io/acme/h@sha256:${'a'.repeat(64)}`),
}))

vi.mock('../../src/lib/docker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/docker.js')>()
  return { ...actual, ...docker }
})

const { registerHarness } = await import('../../src/commands/harness.js')

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'
const DIGEST = 'sha256:' + 'a'.repeat(64)
const DIGEST_REF = `ghcr.io/acme/h@${DIGEST}`

let cleanup: () => Promise<void>
let workdir: string

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerHarness(program)
  await program.parseAsync(args, { from: 'user' })
}

function version(over: Record<string, unknown> = {}) {
  return {
    template: 'h',
    version: 1,
    sourceRef: DIGEST_REF,
    digest: DIGEST,
    status: 'ready',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    ...over,
  }
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  workdir = await mkdtemp(path.join(os.tmpdir(), 'orca-harness-'))
  delete process.env.ORCA_API_KEY
  delete process.env.ORCA_API_URL
  await saveConfig({
    currentContext: 'default',
    contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  docker.dockerAvailable.mockResolvedValue(true)
  docker.resolveDigest.mockResolvedValue(DIGEST_REF)
})

afterEach(async () => {
  await cleanup()
  await rm(workdir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function logged(): string {
  return vi.mocked(console.log).mock.calls.join(' ')
}

describe('harness init', () => {
  it('writes a harness that implements the protocol', async () => {
    const dir = path.join(workdir, 'new')
    await run(['harness', 'init', dir])

    const server = await readFile(path.join(dir, 'server.js'), 'utf8')
    // The three rules a hand-written harness gets wrong. If the scaffold
    // stops carrying them it stops being a working starting point.
    expect(server).toContain("'/health'")
    expect(server).toContain('application/x-ndjson')
    expect(server).toContain('AbortController')
    expect(server).toMatch(/sessionId.*profile.*subtask/s)

    const dockerfile = await readFile(path.join(dir, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('CMD ["node", "server.js"]')
  })

  it('refuses as a set rather than half-writing over an existing harness', async () => {
    const dir = path.join(workdir, 'existing')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'server.js'), 'mine')

    await expect(run(['harness', 'init', dir])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    // The Dockerfile must not have been written either.
    await expect(readFile(path.join(dir, 'Dockerfile'), 'utf8')).rejects.toThrow()
    expect(await readFile(path.join(dir, 'server.js'), 'utf8')).toBe('mine')
  })

  it('overwrites with --force', async () => {
    const dir = path.join(workdir, 'existing')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'server.js'), 'mine')

    await run(['harness', 'init', dir, '--force'])
    expect(await readFile(path.join(dir, 'server.js'), 'utf8')).not.toBe('mine')
  })
})

describe('harness build', () => {
  it('refuses a context with no Dockerfile before touching docker', async () => {
    await expect(
      run(['harness', 'build', workdir, '--image', 'ghcr.io/acme/h']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(docker.build).not.toHaveBeenCalled()
  })

  it('builds and reports that a local build has no digest yet', async () => {
    await writeFile(path.join(workdir, 'Dockerfile'), 'FROM scratch')
    await run(['harness', 'build', workdir, '--image', 'ghcr.io/acme/h', '--tag', 'v1'])

    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'ghcr.io/acme/h:v1', platform: 'linux/amd64' }),
    )
    expect(docker.push).not.toHaveBeenCalled()
    expect(logged()).toContain('linux/amd64')
  })

  it('fails when docker is not installed', async () => {
    await writeFile(path.join(workdir, 'Dockerfile'), 'FROM scratch')
    docker.dockerAvailable.mockResolvedValue(false)
    await expect(
      run(['harness', 'build', workdir, '--image', 'ghcr.io/acme/h']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Failure })
    expect(docker.build).not.toHaveBeenCalled()
  })
})

describe('harness deploy', () => {
  beforeEach(async () => {
    await writeFile(path.join(workdir, 'Dockerfile'), 'FROM scratch')
  })

  it('runs the whole chain and activates', async () => {
    // Empty before the import, holding v1 after it, so the reuse check sees a
    // genuinely new digest.
    let listed = 0
    const calls = stubFetch({
      'GET /api/templates/h': jsonResponse({ name: 'h' }),
      'POST /api/templates/h/versions': jsonResponse(version({ status: 'pending' }), {
        status: 202,
      }),
      'GET /api/templates/h/versions': () => {
        listed += 1
        const versions = listed === 1 ? [] : [version()]
        return new Response(JSON.stringify({ total: versions.length, versions }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
      'POST /api/templates/h/versions/1/activate': jsonResponse({ name: 'h', activeVersion: 1 }),
    })
    await run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h', '--tag', 'v1'])

    expect(docker.build).toHaveBeenCalled()
    expect(docker.push).toHaveBeenCalledWith('ghcr.io/acme/h:v1')
    // The digest, never the tag, is what gets imported.
    const importCall = calls.find(
      (c) => c.method === 'POST' && c.path === '/api/templates/h/versions',
    )
    expect(JSON.parse(importCall?.body as string)).toEqual({ image: DIGEST_REF })
    expect(calls.some((c) => c.path === '/api/templates/h/versions/1/activate')).toBe(true)
    expect(logged()).toContain('Deployed')
  })

  it('creates the template when it does not exist yet', async () => {
    const calls = stubFetch({
      'GET /api/templates/h': jsonResponse({ error: 'not found' }, { status: 404 }),
      'POST /api/templates': jsonResponse({ name: 'h' }, { status: 201 }),
      'POST /api/templates/h/versions': jsonResponse(version({ status: 'pending' }), {
        status: 202,
      }),
      'GET /api/templates/h/versions': jsonResponse({ total: 1, versions: [version()] }),
      'POST /api/templates/h/versions/1/activate': jsonResponse({ name: 'h', activeVersion: 1 }),
    })
    await run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h', '--tag', 'v1'])
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/templates')).toBe(true)
  })

  it('--no-activate imports without moving the pointer', async () => {
    const calls = stubFetch({
      'GET /api/templates/h': jsonResponse({ name: 'h' }),
      'POST /api/templates/h/versions': jsonResponse(version({ status: 'pending' }), {
        status: 202,
      }),
      'GET /api/templates/h/versions': jsonResponse({ total: 1, versions: [version()] }),
    })
    await run([
      'harness', 'deploy', 'h', workdir,
      '--image', 'ghcr.io/acme/h', '--tag', 'v1', '--no-activate',
    ])
    expect(calls.some((c) => c.path.endsWith('/activate'))).toBe(false)
    expect(logged()).toContain('not activated')
  })

  it('--skip-build pushes an image that is already built', async () => {
    stubFetch({
      'GET /api/templates/h': jsonResponse({ name: 'h' }),
      'POST /api/templates/h/versions': jsonResponse(version({ status: 'pending' }), {
        status: 202,
      }),
      'GET /api/templates/h/versions': jsonResponse({ total: 1, versions: [version()] }),
      'POST /api/templates/h/versions/1/activate': jsonResponse({ name: 'h', activeVersion: 1 }),
    })
    await run([
      'harness', 'deploy', 'h', workdir,
      '--image', 'ghcr.io/acme/h', '--tag', 'v1', '--skip-build',
    ])
    expect(docker.build).not.toHaveBeenCalled()
    expect(docker.push).toHaveBeenCalled()
  })

  it('points at the private-registry limitation when the import fails', async () => {
    // The mirror has no way to authenticate to a tenant's private registry,
    // and a new GHCR package is private by default, so this is the most
    // likely failure a first deploy hits.
    stubFetch({
      'GET /api/templates/h': jsonResponse({ name: 'h' }),
      'POST /api/templates/h/versions': jsonResponse(version({ status: 'pending' }), {
        status: 202,
      }),
      'GET /api/templates/h/versions': jsonResponse({
        total: 1,
        versions: [version({ status: 'failed', failureReason: 'UNAUTHORIZED: authentication required' })],
      }),
    })
    await expect(
      run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h', '--tag', 'v1']),
    ).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      detail: expect.arrayContaining([expect.stringContaining('pullable without credentials')]),
    })
  })

  it('reuses an existing version with the same digest instead of minting another', async () => {
    // Deploying twice unchanged yields the same digest, and the server has no
    // uniqueness on it, so a second import would be a duplicate version over
    // identical bytes plus a pointless re-mirror.
    const calls = stubFetch({
      'GET /api/templates/h': jsonResponse({ name: 'h' }),
      'GET /api/templates/h/versions': jsonResponse({ total: 1, versions: [version()] }),
      'POST /api/templates/h/versions/1/activate': jsonResponse({ name: 'h', activeVersion: 1 }),
    })
    await run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h', '--tag', 'v1'])
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/templates/h/versions')).toBe(
      false,
    )
    expect(calls.some((c) => c.path.endsWith('/activate'))).toBe(true)
  })

  it('re-imports when the only version with that digest failed', async () => {
    // Before the import the template holds just the failed v1; afterwards the
    // poll sees the new v2. A single fixed body cannot express that, so the
    // versions route answers from call order.
    let listed = 0
    const calls = stubFetch({
      'GET /api/templates/h': jsonResponse({ name: 'h' }),
      'POST /api/templates/h/versions': jsonResponse(version({ version: 2, status: 'pending' }), {
        status: 202,
      }),
      'GET /api/templates/h/versions': () => {
        listed += 1
        const versions =
          listed === 1
            ? [version({ status: 'failed', failureReason: 'blip' })]
            : [version({ status: 'failed', failureReason: 'blip' }), version({ version: 2 })]
        return new Response(JSON.stringify({ total: versions.length, versions }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
      'POST /api/templates/h/versions/2/activate': jsonResponse({ name: 'h', activeVersion: 2 }),
    })
    await run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h', '--tag', 'v1'])
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/templates/h/versions')).toBe(
      true,
    )
    expect(calls.some((c) => c.path === '/api/templates/h/versions/2/activate')).toBe(true)
  })

  it('keeps the auth exit code when the key is present but rejected', async () => {
    // An ApiError is an Error, so a catch-all mapper would collapse this to
    // exit 1 with "401 Unauthorized" instead of exit 3 and the login hint.
    stubFetch({
      'GET /api/templates/h': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(
      run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h', '--tag', 'v1']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })

  it('requires --tag with --skip-build, since the default tag is dated', async () => {
    await expect(
      run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h', '--skip-build']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(docker.push).not.toHaveBeenCalled()
  })

  it('does not build when the API key is missing', async () => {
    // Resolving the context first is what stops a five-minute build from
    // ending in an auth error.
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080' } },
    })
    await expect(
      run(['harness', 'deploy', 'h', workdir, '--image', 'ghcr.io/acme/h']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Auth })
    expect(docker.build).not.toHaveBeenCalled()
  })
})
