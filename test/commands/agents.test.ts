import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerAgents } from '../../src/commands/agents.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program
    .exitOverride()
    .option('--context <name>')
    .option('--api-url <url>')
    .option('--json')
  registerAgents(program)
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

describe('agents list', () => {
  it('emits raw profiles with --json', async () => {
    stubFetch({
      'GET /api/profiles?limit=10': jsonResponse([{ name: 'a', runtime: 'claude' }]),
    })
    await run(['--json', 'agents', 'list'])
    expect(JSON.parse(stdout())).toEqual([{ name: 'a', runtime: 'claude' }])
  })

  it('sends the default limit of 10 and passes --limit/--offset through', async () => {
    const calls = stubFetch({
      'GET /api/profiles?limit=10': jsonResponse([{ name: 'a', runtime: 'claude' }]),
      'GET /api/profiles?limit=10&offset=20': jsonResponse([{ name: 'a', runtime: 'claude' }]),
      'GET /api/published?limit=200': jsonResponse({ publishedAgents: [], total: 0 }),
    })
    await run(['--json', 'agents', 'list'])
    expect(calls[0].path).toBe('/api/profiles?limit=10')
    await run(['--json', 'agents', 'list', '--limit', '10', '--offset', '20'])
    expect(calls[1].path).toBe('/api/profiles?limit=10&offset=20')
  })

  it('rejects a non-positive --limit as a usage error', async () => {
    const calls = stubFetch({})
    await expect(run(['agents', 'list', '--limit', '0'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('prints tab-separated rows in plain mode with published state', async () => {
    stubFetch({
      'GET /api/profiles?limit=10': jsonResponse([
        { name: 'a', runtime: 'claude', model: 'm1' },
        { name: 'b', runtime: 'codex' },
      ]),
      'GET /api/published?limit=200': jsonResponse({
        publishedAgents: [{ profileName: 'a', publicUrl: 'https://x' }],
        total: 1,
      }),
    })
    await run(['agents', 'list'])
    expect(stdout()).toBe('a\tclaude\tm1\tyes\nb\tcodex\t-\tno\n')
  })

  it('degrades the published column when the endpoint fails', async () => {
    stubFetch({
      'GET /api/profiles?limit=10': jsonResponse([{ name: 'a', runtime: 'claude' }]),
      'GET /api/published?limit=200': jsonResponse({ error: 'boom' }, { status: 500 }),
    })
    await run(['agents', 'list'])
    expect(stdout()).toBe('a\tclaude\t-\t?\n')
  })

  it('shows the "Showing X of Y" hint on stderr when the server has more', async () => {
    stubFetch({
      'GET /api/profiles?limit=10': jsonResponse([{ name: 'a', runtime: 'claude' }], {
        headers: { 'X-Total-Count': '130' },
      }),
      'GET /api/published?limit=200': jsonResponse({ publishedAgents: [], total: 0 }),
    })
    await run(['agents', 'list'])
    // Rows land on stdout; the hint lands on stderr only.
    expect(stdout()).toBe('a\tclaude\t-\tno\n')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 130')
  })

  it('pages the published set so a badge for an agent past the first page resolves', async () => {
    const firstPub = Array.from({ length: 200 }, (_, i) => ({
      profileName: `x${i}`,
      publicUrl: 'https://x',
    }))
    stubFetch({
      'GET /api/profiles?limit=10': jsonResponse([{ name: 'late', runtime: 'claude' }]),
      'GET /api/published?limit=200': jsonResponse({ publishedAgents: firstPub, total: 201 }),
      'GET /api/published?limit=200&offset=200': jsonResponse({
        publishedAgents: [{ profileName: 'late', publicUrl: 'https://x' }],
        total: 201,
      }),
    })
    await run(['agents', 'list'])
    expect(stdout()).toBe('late\tclaude\t-\tyes\n')
  })

  it('--all pages through every profile and concatenates', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ({ name: `p${i}`, runtime: 'claude' }))
    const calls = stubFetch({
      'GET /api/profiles?limit=200': jsonResponse(first, { headers: { 'X-Total-Count': '201' } }),
      'GET /api/profiles?limit=200&offset=200': jsonResponse([{ name: 'p200', runtime: 'codex' }], {
        headers: { 'X-Total-Count': '201' },
      }),
    })
    await run(['--json', 'agents', 'list', '--all'])
    expect(JSON.parse(stdout())).toHaveLength(201)
    expect(calls.map((c) => c.path)).toEqual([
      '/api/profiles?limit=200',
      '/api/profiles?limit=200&offset=200',
    ])
  })
})

describe('agents get', () => {
  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/profiles/nope': jsonResponse({ error: 'unknown_profile: nope' }, { status: 404 }),
    })
    await expect(run(['agents', 'get', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('agents create', () => {
  it('posts the validated profile from YAML', async () => {
    const calls = stubFetch({
      'POST /api/profiles': jsonResponse({ name: 'support-bot', runtime: 'claude' }),
    })
    await run(['agents', 'create', '-f', path.join(fixtures, 'agent.yaml')])
    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body.name).toBe('support-bot')
    expect(body.sandbox.provider).toBe('e2b')
  })

  it('fails validation before any network call', async () => {
    const calls = stubFetch({})
    await expect(
      run(['agents', 'create', '-f', path.join(fixtures, 'agent-bad.yaml')]),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })
})

describe('agents update', () => {
  it('targets the positional name to support rename', async () => {
    const calls = stubFetch({
      'PUT /api/profiles/old-bot': jsonResponse({ name: 'support-bot', runtime: 'claude' }),
    })
    await run(['agents', 'update', 'old-bot', '-f', path.join(fixtures, 'agent.yaml')])
    expect(calls).toHaveLength(1)
  })

  it('defaults the target to the document name', async () => {
    const calls = stubFetch({
      'PUT /api/profiles/support-bot': jsonResponse({ name: 'support-bot', runtime: 'claude' }),
    })
    await run(['agents', 'update', '-f', path.join(fixtures, 'agent.yaml')])
    expect(calls).toHaveLength(1)
  })
})

describe('agents delete', () => {
  it('refuses without --yes when not interactive', async () => {
    stubFetch({})
    await expect(run(['agents', 'delete', 'a'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/profiles/a': () => new Response(null, { status: 204 }),
    })
    await run(['agents', 'delete', 'a', '--yes'])
    expect(calls).toHaveLength(1)
  })
})
