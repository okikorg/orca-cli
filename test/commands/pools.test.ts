import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerPools } from '../../src/commands/pools.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerPools(program)
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

describe('pools list', () => {
  it('emits raw pools with --json and sends the default limit', async () => {
    const calls = stubFetch({
      'GET /api/pools?limit=10': jsonResponse([{ name: 'team', members: [{ profile: 'a', role: 'lead' }] }]),
    })
    await run(['--json', 'pools', 'list'])
    expect(JSON.parse(stdout())).toEqual([
      { name: 'team', members: [{ profile: 'a', role: 'lead' }] },
    ])
    expect(calls[0].path).toBe('/api/pools?limit=10')
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/pools?limit=10': jsonResponse([
        { name: 'team', description: 'squad', members: [{ profile: 'a', role: 'lead' }, { profile: 'b' }] },
      ]),
    })
    await run(['pools', 'list'])
    expect(stdout()).toBe('team\t2\ta (lead), b\tsquad\n')
  })

  it('forwards --limit/--offset and hints on stderr when the server has more', async () => {
    const calls = stubFetch({
      'GET /api/pools?limit=1&offset=2': jsonResponse(
        [{ name: 'team', members: [{ profile: 'a', role: 'lead' }] }],
        { headers: { 'X-Total-Count': '9' } },
      ),
    })
    await run(['pools', 'list', '--limit', '1', '--offset', '2'])
    expect(calls[0].path).toBe('/api/pools?limit=1&offset=2')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 9')
  })

  it('shows an empty-state hint when there are no pools', async () => {
    stubFetch({ 'GET /api/pools?limit=10': jsonResponse([]) })
    await run(['pools', 'list'])
    expect(stdout()).toBe('')
    expect(vi.mocked(console.error)).toHaveBeenCalled()
  })
})

describe('pools get', () => {
  it('finds the pool from the list', async () => {
    stubFetch({
      'GET /api/pools?limit=200': jsonResponse([
        { name: 'other', members: [] },
        { name: 'team', id: 'pool-abc', members: [{ profile: 'a', role: 'lead' }] },
      ]),
    })
    await run(['--json', 'pools', 'get', 'team'])
    expect(JSON.parse(stdout())).toMatchObject({ name: 'team', id: 'pool-abc' })
  })

  it('maps a missing pool to the not-found exit code', async () => {
    stubFetch({ 'GET /api/pools?limit=200': jsonResponse([{ name: 'other', members: [] }]) })
    await expect(run(['pools', 'get', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })

  it('finds a pool that lives past the first 200-row page', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ({ name: `p${i}`, members: [] }))
    const calls = stubFetch({
      'GET /api/pools?limit=200': jsonResponse(first, { headers: { 'X-Total-Count': '201' } }),
      'GET /api/pools?limit=200&offset=200': jsonResponse(
        [{ name: 'team', id: 'pool-z', members: [] }],
        { headers: { 'X-Total-Count': '201' } },
      ),
    })
    await run(['--json', 'pools', 'get', 'team'])
    expect(JSON.parse(stdout())).toMatchObject({ name: 'team', id: 'pool-z' })
    expect(calls).toHaveLength(2)
  })
})

describe('pools create', () => {
  it('posts name, parsed members, and fs policy', async () => {
    const calls = stubFetch({
      'POST /api/pools': jsonResponse({ name: 'team', id: 'pool-1', members: [] }, { status: 201 }),
    })
    await run([
      'pools',
      'create',
      'team',
      '--description',
      'the squad',
      '--member',
      'alpha:lead',
      '--member',
      'beta',
      '--read',
      '/pools/{pool}/datasets/**',
      '--deny',
      '/pools/{pool}/secrets/**',
    ])
    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body).toEqual({
      name: 'team',
      description: 'the squad',
      members: [{ profile: 'alpha', role: 'lead' }, { profile: 'beta' }],
      fs: { read: ['/pools/{pool}/datasets/**'], deny: ['/pools/{pool}/secrets/**'] },
    })
  })

  it('rejects an invalid member role before any network call', async () => {
    const calls = stubFetch({})
    await expect(run(['pools', 'create', 'team', '--member', 'alpha:boss'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('maps a 409 conflict to the usage exit code', async () => {
    stubFetch({
      'POST /api/pools': jsonResponse({ error: 'pool already registered' }, { status: 409 }),
    })
    await expect(run(['pools', 'create', 'team'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })
})

describe('pools delete', () => {
  it('refuses without --yes when not interactive', async () => {
    stubFetch({})
    await expect(run(['pools', 'delete', 'team'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/pools/team': () => new Response(null, { status: 204 }),
    })
    await run(['pools', 'delete', 'team', '--yes'])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
  })
})

describe('pools members', () => {
  it('adds a member with a role as a query param', async () => {
    const calls = stubFetch({
      'POST /api/pools/team/members/alpha?role=lead': () => new Response(null, { status: 200 }),
    })
    await run(['pools', 'members', 'add', 'team', 'alpha', '--role', 'lead'])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/api/pools/team/members/alpha?role=lead')
  })

  it('adds a member with no role', async () => {
    const calls = stubFetch({
      'POST /api/pools/team/members/beta': () => new Response(null, { status: 200 }),
    })
    await run(['pools', 'members', 'add', 'team', 'beta'])
    expect(calls[0].path).toBe('/api/pools/team/members/beta')
  })

  it('rejects an invalid role', async () => {
    const calls = stubFetch({})
    await expect(
      run(['pools', 'members', 'add', 'team', 'alpha', '--role', 'boss']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('removes a member with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/pools/team/members/alpha': () => new Response(null, { status: 204 }),
    })
    await run(['pools', 'members', 'remove', 'team', 'alpha', '--yes'])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
  })

  it('refuses to remove without --yes when not interactive', async () => {
    stubFetch({})
    await expect(run(['pools', 'members', 'remove', 'team', 'alpha'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('maps a 404 on member add to the not-found exit code', async () => {
    stubFetch({
      'POST /api/pools/ghost/members/alpha': jsonResponse(
        { error: 'pool not found' },
        { status: 404 },
      ),
    })
    await expect(run(['pools', 'members', 'add', 'ghost', 'alpha'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})
