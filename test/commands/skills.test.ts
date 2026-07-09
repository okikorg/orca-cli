import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerSkills } from '../../src/commands/skills.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerSkills(program)
  await program.parseAsync(args, { from: 'user' })
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  delete process.env.ORCA_API_KEY
  delete process.env.ORCA_API_URL
  await saveConfig({
    currentContext: 'default',
    contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
  })
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

describe('skills list', () => {
  it('emits the raw catalog array with --json and sends the default limit', async () => {
    const calls = stubFetch({
      'GET /api/skills?limit=10': jsonResponse([{ name: 'docs', body: 'x', source: 'imported' }]),
    })
    await run(['--json', 'skills', 'list'])
    expect(JSON.parse(stdout())).toEqual([{ name: 'docs', body: 'x', source: 'imported' }])
    expect(calls[0].path).toBe('/api/skills?limit=10')
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/skills?limit=10': jsonResponse([
        { name: 'docs', body: 'x', source: 'imported', description: 'Docs', resources: [{ path: 'scripts/run.sh' }] },
        { name: 'plain', body: 'y' },
      ]),
    })
    await run(['skills', 'list'])
    expect(stdout()).toBe('docs\timported\t1\tDocs\nplain\tuser\t0\t-\n')
  })

  it('forwards --limit/--offset and hints on stderr when the server has more', async () => {
    const calls = stubFetch({
      'GET /api/skills?limit=1&offset=2': jsonResponse(
        [{ name: 'docs', body: 'x', source: 'imported' }],
        { headers: { 'X-Total-Count': '8' } },
      ),
    })
    await run(['skills', 'list', '--limit', '1', '--offset', '2'])
    expect(calls[0].path).toBe('/api/skills?limit=1&offset=2')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 8')
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({
      'GET /api/skills?limit=10': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['skills', 'list'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })

  it('names the import command in the empty state, keeping stdout clean', async () => {
    stubFetch({ 'GET /api/skills?limit=10': jsonResponse([]) })
    await run(['skills', 'list'])
    expect(stdout()).toBe('')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('orca skills import')
  })
})

describe('skills get', () => {
  it('emits the raw skill with --json', async () => {
    stubFetch({
      'GET /api/skills/docs': jsonResponse({ name: 'docs', body: 'hello', source: 'user' }),
    })
    await run(['--json', 'skills', 'get', 'docs'])
    expect(JSON.parse(stdout())).toEqual({ name: 'docs', body: 'hello', source: 'user' })
  })

  it('prints metadata rows in plain mode', async () => {
    stubFetch({
      'GET /api/skills/docs': jsonResponse({
        name: 'docs',
        body: 'hello',
        source: 'imported',
        description: 'Docs skill',
        tags: ['a', 'b'],
        resources: [{ path: 'refs/x.md' }],
      }),
    })
    await run(['skills', 'get', 'docs'])
    expect(stdout()).toBe('name\tdocs\nsource\timported\ndescription\tDocs skill\ntags\ta,b\nresources\t1\n')
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/skills/nope': jsonResponse({ error: 'skill "nope" not found' }, { status: 404 }),
    })
    await expect(run(['skills', 'get', 'nope'])).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })

  it('prints a raw resource file with --resource', async () => {
    const calls = stubFetch({
      'GET /api/skills/docs/resources/scripts/run.sh': () =>
        new Response('#!/bin/sh\necho hi\n', { status: 200 }),
    })
    await run(['skills', 'get', 'docs', '--resource', 'scripts/run.sh'])
    expect(stdout()).toBe('#!/bin/sh\necho hi\n')
    expect(calls[0].method).toBe('GET')
  })
})

describe('skills delete', () => {
  it('refuses without --yes when not interactive', async () => {
    stubFetch({})
    await expect(run(['skills', 'delete', 'docs'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/skills/docs': () => new Response(null, { status: 204 }),
    })
    await run(['skills', 'delete', 'docs', '--yes'])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
  })
})

describe('skills attach', () => {
  it('attaches via the dedicated endpoint when not present, sending no profile body', async () => {
    const calls = stubFetch({
      'GET /api/profiles/bot': jsonResponse({ name: 'bot', runtime: 'claude', skills: ['other'] }),
      'POST /api/profiles/bot/skills/docs': () => new Response(null, { status: 204 }),
    })
    await run(['skills', 'attach', 'bot', 'docs'])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/profiles/bot',
      'POST /api/profiles/bot/skills/docs',
    ])
    // No whole-profile PUT, and the attach carries no body.
    expect(calls[1].body).toBeUndefined()
  })

  it('is a no-op when already attached (exit 0, no write)', async () => {
    const calls = stubFetch({
      'GET /api/profiles/bot': jsonResponse({ name: 'bot', runtime: 'claude', skills: ['docs'] }),
    })
    await run(['skills', 'attach', 'bot', 'docs'])
    expect(calls).toHaveLength(1)
  })

  it('maps a missing agent to the not-found exit code', async () => {
    stubFetch({
      'GET /api/profiles/nope': jsonResponse({ error: 'profile "nope" not found' }, { status: 404 }),
    })
    await expect(run(['skills', 'attach', 'nope', 'docs'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })

  it('maps a skill not in the catalog to the usage exit code', async () => {
    stubFetch({
      'GET /api/profiles/bot': jsonResponse({ name: 'bot', runtime: 'claude', skills: [] }),
      'POST /api/profiles/bot/skills/ghost': jsonResponse({ error: 'skill "ghost" not found' }, { status: 404 }),
    })
    await expect(run(['skills', 'attach', 'bot', 'ghost'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('maps auth failure to exit 3', async () => {
    stubFetch({
      'GET /api/profiles/bot': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['skills', 'attach', 'bot', 'docs'])).rejects.toMatchObject({
      exitCode: ExitCode.Auth,
    })
  })

  it('emits a changed:false record with --json when already attached', async () => {
    stubFetch({
      'GET /api/profiles/bot': jsonResponse({ name: 'bot', runtime: 'claude', skills: ['docs'] }),
    })
    await run(['--json', 'skills', 'attach', 'bot', 'docs'])
    expect(JSON.parse(stdout())).toEqual({ agent: 'bot', skill: 'docs', attached: true, changed: false })
  })
})

describe('skills detach', () => {
  it('detaches via the dedicated endpoint when present', async () => {
    const calls = stubFetch({
      'GET /api/profiles/bot': jsonResponse({ name: 'bot', runtime: 'claude', skills: ['docs', 'other'] }),
      'DELETE /api/profiles/bot/skills/docs': () => new Response(null, { status: 204 }),
    })
    await run(['skills', 'detach', 'bot', 'docs'])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/profiles/bot',
      'DELETE /api/profiles/bot/skills/docs',
    ])
  })

  it('is a no-op when the skill was not attached (exit 0, no write)', async () => {
    const calls = stubFetch({
      'GET /api/profiles/bot': jsonResponse({ name: 'bot', runtime: 'claude', skills: ['other'] }),
    })
    await run(['skills', 'detach', 'bot', 'docs'])
    expect(calls).toHaveLength(1)
  })

  it('maps a missing agent to the not-found exit code', async () => {
    stubFetch({
      'GET /api/profiles/nope': jsonResponse({ error: 'profile "nope" not found' }, { status: 404 }),
    })
    await expect(run(['skills', 'detach', 'nope', 'docs'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('skills import', () => {
  let skillDir: string

  beforeEach(async () => {
    skillDir = await mkdtemp(path.join(os.tmpdir(), 'orca-skill-'))
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill\n---\nDo the thing.\n',
    )
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true })
    await writeFile(path.join(skillDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
  })

  afterEach(async () => {
    await rm(skillDir, { recursive: true, force: true })
  })

  const preview = (ok: boolean) =>
    jsonResponse({
      skill: { name: 'my-skill', description: 'A test skill', body: 'Do the thing.' },
      resources: [{ path: 'scripts/run.sh', size: 18, executable: true }],
      validation: { ok, errors: ok ? [] : ['name must match'], warnings: [] },
      requiresSandbox: true,
      totalBytes: 18,
      stagingId: 'stage-123',
    })

  it('dry-runs then commits with the staging id', async () => {
    const calls = stubFetch({
      'POST /api/skills/import-package?dryRun=1': preview(true),
      'POST /api/skills/import-package/commit': jsonResponse(
        { name: 'my-skill', body: 'Do the thing.', resources: [{ path: 'scripts/run.sh' }] },
        { status: 201 },
      ),
    })
    await run(['skills', 'import', skillDir])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/skills/import-package?dryRun=1',
      'POST /api/skills/import-package/commit',
    ])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ stagingId: 'stage-123', force: false })
  })

  it('stops after the preview with --dry-run', async () => {
    const calls = stubFetch({
      'POST /api/skills/import-package?dryRun=1': preview(true),
    })
    await run(['skills', 'import', skillDir, '--dry-run'])
    expect(calls).toHaveLength(1)
  })

  it('fails validation without committing', async () => {
    const calls = stubFetch({
      'POST /api/skills/import-package?dryRun=1': preview(false),
    })
    await expect(run(['skills', 'import', skillDir])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(1)
  })

  it('forwards --force to the commit body', async () => {
    const calls = stubFetch({
      'POST /api/skills/import-package?dryRun=1': preview(true),
      'POST /api/skills/import-package/commit': jsonResponse({ name: 'my-skill', body: 'x' }, { status: 201 }),
    })
    await run(['skills', 'import', skillDir, '--force'])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ stagingId: 'stage-123', force: true })
  })

  it('rejects a directory without SKILL.md before any network call', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'orca-empty-'))
    const calls = stubFetch({})
    try {
      await expect(run(['skills', 'import', empty])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
      expect(calls).toHaveLength(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
