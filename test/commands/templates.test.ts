import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerTemplates } from '../../src/commands/templates.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'
const DIGEST = 'sha256:' + 'a'.repeat(64)
const IMAGE = `ghcr.io/acme/harness@${DIGEST}`

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerTemplates(program)
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

function stderr(): string {
  return vi.mocked(console.error).mock.calls.join(' ')
}

function logged(): string {
  return vi.mocked(console.log).mock.calls.join(' ')
}

function version(over: Record<string, unknown> = {}) {
  return {
    template: 'harness',
    version: 1,
    sourceRef: IMAGE,
    digest: DIGEST,
    status: 'ready',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    ...over,
  }
}

describe('templates list', () => {
  it('unwraps the templates envelope with --json and sends the default limit', async () => {
    const calls = stubFetch({
      'GET /api/templates?limit=10': jsonResponse({
        total: 1,
        templates: [{ name: 'harness', activeVersion: 2 }],
      }),
    })
    await run(['--json', 'templates', 'list'])
    expect(JSON.parse(stdout())).toEqual([{ name: 'harness', activeVersion: 2 }])
    expect(calls[0].path).toBe('/api/templates?limit=10')
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/templates?limit=10': jsonResponse({
        total: 2,
        templates: [
          { name: 'harness', activeVersion: 2, description: 'Invoices' },
          { name: 'bare' },
        ],
      }),
    })
    await run(['templates', 'list'])
    expect(stdout()).toBe('harness\tv2\tInvoices\nbare\t-\t-\n')
  })

  it('names the create command in the empty state, keeping stdout clean', async () => {
    stubFetch({ 'GET /api/templates?limit=10': jsonResponse({ total: 0, templates: [] }) })
    await run(['templates', 'list'])
    expect(stdout()).toBe('')
    expect(stderr()).toContain('orca templates create')
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({
      'GET /api/templates?limit=10': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['templates', 'list'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('templates get', () => {
  it('merges the versions into the template with --json', async () => {
    stubFetch({
      'GET /api/templates/harness': jsonResponse({ name: 'harness', activeVersion: 1 }),
      'GET /api/templates/harness/versions': jsonResponse({ total: 1, versions: [version()] }),
    })
    await run(['--json', 'templates', 'get', 'harness'])
    const out = JSON.parse(stdout())
    expect(out.name).toBe('harness')
    expect(out.versions).toHaveLength(1)
    expect(out.versions[0].digest).toBe(DIGEST)
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/templates/nope': jsonResponse({ error: 'template not found' }, { status: 404 }),
    })
    await expect(run(['templates', 'get', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('templates create', () => {
  it('posts the name and description', async () => {
    const calls = stubFetch({
      'POST /api/templates': jsonResponse({ name: 'harness' }, { status: 201 }),
    })
    await run(['templates', 'create', 'harness', '--description', 'Invoices'])
    expect(JSON.parse(calls[0].body as string)).toEqual({
      name: 'harness',
      description: 'Invoices',
    })
    expect(logged()).toContain('harness')
  })

  it('explains a 409 rather than surfacing the bare conflict', async () => {
    stubFetch({
      'POST /api/templates': jsonResponse({ error: 'template exists' }, { status: 409 }),
    })
    await expect(run(['templates', 'create', 'harness'])).rejects.toMatchObject({
      message: expect.stringContaining('already exists'),
    })
  })

  it('says what is missing when the server has no template store', async () => {
    stubFetch({
      'POST /api/templates': jsonResponse(
        { error: 'template store not configured (POSTGRES_DSN required)' },
        { status: 503 },
      ),
    })
    await expect(run(['templates', 'create', 'harness'])).rejects.toMatchObject({
      message: expect.stringContaining('no template store'),
    })
  })
})

describe('templates delete', () => {
  it('refuses without --yes in non-interactive mode', async () => {
    // No fetch stub: the guard must fire before any request is made.
    await expect(run(['templates', 'delete', 'harness'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/templates/harness': () => new Response(null, { status: 204 }),
    })
    await run(['templates', 'delete', 'harness', '--yes'])
    expect(calls[0].method).toBe('DELETE')
    expect(logged()).toContain('harness')
  })

  it('surfaces the referencing agent when the server refuses', async () => {
    stubFetch({
      'DELETE /api/templates/harness': jsonResponse(
        { error: 'template harness is referenced by profile invoice-agent' },
        { status: 409 },
      ),
    })
    await expect(run(['templates', 'delete', 'harness', '--yes'])).rejects.toMatchObject({
      message: expect.stringContaining('invoice-agent'),
    })
  })
})

describe('templates versions', () => {
  it('prints one row per version in plain mode, marking the active one', async () => {
    stubFetch({
      'GET /api/templates/harness': jsonResponse({ name: 'harness', activeVersion: 1 }),
      'GET /api/templates/harness/versions': jsonResponse({
        total: 2,
        versions: [
          version(),
          version({ version: 2, status: 'failed', failureReason: 'manifest unknown' }),
        ],
      }),
    })
    await run(['templates', 'versions', 'harness'])
    expect(stdout()).toBe(
      `1\tready\t${'a'.repeat(12)}\tyes\t\n2\tfailed\t${'a'.repeat(12)}\t\tmanifest unknown\n`,
    )
  })

  it('names the import command when there are no versions yet', async () => {
    stubFetch({
      'GET /api/templates/harness': jsonResponse({ name: 'harness' }),
      'GET /api/templates/harness/versions': jsonResponse({ total: 0, versions: [] }),
    })
    await run(['templates', 'versions', 'harness'])
    expect(stdout()).toBe('')
    expect(stderr()).toContain('orca templates import harness')
  })
})

describe('templates import', () => {
  it('rejects a tag before making any request', async () => {
    // Deliberately no fetch stub. A tag must never reach the network: the
    // check exists so the user reads why, not a server 400.
    await expect(
      run(['templates', 'import', 'harness', 'ghcr.io/acme/harness:v1']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('posts the image and reports the pending version without --wait', async () => {
    const calls = stubFetch({
      'POST /api/templates/harness/versions': jsonResponse(
        version({ status: 'pending' }),
        { status: 202 },
      ),
    })
    await run(['templates', 'import', 'harness', IMAGE])
    expect(JSON.parse(calls[0].body as string)).toEqual({ image: IMAGE })
    // Exactly one call: without --wait it must not poll.
    expect(calls).toHaveLength(1)
    expect(logged()).toContain('pending')
  })

  it('--wait polls the version list and reports ready', async () => {
    const calls = stubFetch({
      'POST /api/templates/harness/versions': jsonResponse(
        version({ status: 'pending' }),
        { status: 202 },
      ),
      'GET /api/templates/harness/versions': jsonResponse({
        total: 1,
        versions: [version({ status: 'ready' })],
      }),
    })
    await run(['templates', 'import', 'harness', IMAGE, '--wait'])
    expect(calls).toHaveLength(2)
    expect(logged()).toContain('Imported')
    expect(stderr()).toContain('orca templates activate harness 1')
  })

  it('--wait exits non-zero with the reason when the import failed', async () => {
    stubFetch({
      'POST /api/templates/harness/versions': jsonResponse(
        version({ status: 'pending' }),
        { status: 202 },
      ),
      'GET /api/templates/harness/versions': jsonResponse({
        total: 1,
        versions: [version({ status: 'failed', failureReason: 'manifest unknown' })],
      }),
    })
    await expect(
      run(['templates', 'import', 'harness', IMAGE, '--wait']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Failure, message: 'manifest unknown' })
  })

  it('--wait still exits non-zero on a failed import in --json mode', async () => {
    // The body is printed either way; a script that only checks the exit code
    // must not read a failed import as a success.
    stubFetch({
      'POST /api/templates/harness/versions': jsonResponse(
        version({ status: 'pending' }),
        { status: 202 },
      ),
      'GET /api/templates/harness/versions': jsonResponse({
        total: 1,
        versions: [version({ status: 'failed', failureReason: 'manifest unknown' })],
      }),
    })
    await expect(
      run(['--json', 'templates', 'import', 'harness', IMAGE, '--wait']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Failure })
    expect(JSON.parse(stdout()).status).toBe('failed')
  })

  it('--wait reports a template deleted mid-import as not found', async () => {
    stubFetch({
      'POST /api/templates/harness/versions': jsonResponse(
        version({ status: 'pending' }),
        { status: 202 },
      ),
      'GET /api/templates/harness/versions': jsonResponse({ total: 0, versions: [] }),
    })
    await expect(
      run(['templates', 'import', 'harness', IMAGE, '--wait']),
    ).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })

  it('rejects a non-positive --timeout', async () => {
    await expect(
      run(['templates', 'import', 'harness', IMAGE, '--wait', '--timeout', '0']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  // Real timers, so this one costs the poll interval (~3s). Every other
  // --wait case settles on the first poll, which leaves the sleep, the second
  // fetch, and the give-up branch with no coverage at all. Fake timers do not
  // work here: the command awaits a config read from disk before it ever
  // schedules the sleep, so advancing the clock first starves the loop.
  it('--wait keeps polling while in flight, then gives up at the timeout', async () => {
    const calls = stubFetch({
      'POST /api/templates/harness/versions': jsonResponse(
        version({ status: 'pending' }),
        { status: 202 },
      ),
      'GET /api/templates/harness/versions': jsonResponse({
        total: 1,
        versions: [version({ status: 'mirroring' })],
      }),
    })
    // 1s deadline: the first poll is inside it, the second is past it.
    await expect(
      run(['templates', 'import', 'harness', IMAGE, '--wait', '--timeout', '1']),
    ).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: expect.stringContaining('still mirroring'),
    })
    // Import, first poll, second poll: the loop actually went round.
    expect(calls).toHaveLength(3)
  }, 15_000)
})

describe('templates activate', () => {
  it('posts to the activate route', async () => {
    const calls = stubFetch({
      'POST /api/templates/harness/versions/2/activate': jsonResponse({
        name: 'harness',
        activeVersion: 2,
      }),
    })
    await run(['templates', 'activate', 'harness', '2'])
    expect(calls[0].method).toBe('POST')
    expect(logged()).toContain('v2')
  })

  it('rejects a non-numeric version without calling the API', async () => {
    await expect(run(['templates', 'activate', 'harness', 'latest'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('explains that only a ready version can be activated on 409', async () => {
    stubFetch({
      'POST /api/templates/harness/versions/2/activate': jsonResponse(
        { error: 'template version is not ready' },
        { status: 409 },
      ),
    })
    await expect(run(['templates', 'activate', 'harness', '2'])).rejects.toMatchObject({
      message: expect.stringContaining('not ready'),
      detail: expect.arrayContaining([expect.stringContaining('orca templates versions harness')]),
    })
  })
})
