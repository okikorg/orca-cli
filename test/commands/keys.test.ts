import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerAgents } from '../../src/commands/agents.js'
import { registerKeys } from '../../src/commands/keys.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program
    .exitOverride()
    .option('--context <name>')
    .option('--api-url <url>')
    .option('--json')
  registerAgents(program)
  registerKeys(program)
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

describe('agents publish', () => {
  it('publishes and prints the public URL', async () => {
    const calls = stubFetch({
      'POST /api/profiles/support-bot/publish': jsonResponse({
        profileName: 'support-bot',
        slug: 'support-bot',
        publicUrl: 'https://agents.example/v1/chat/t/support-bot',
      }),
    })
    await run(['agents', 'publish', 'support-bot', '--slug', 'support-bot'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ slug: 'support-bot' })
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      'https://agents.example/v1/chat/t/support-bot',
    )
  })

  it('rejects a bad visibility value before any network call', async () => {
    const calls = stubFetch({})
    await expect(
      run(['agents', 'publish', 'support-bot', '--visibility', 'everyone']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })
})

describe('agents unpublish', () => {
  it('refuses without --yes when not interactive', async () => {
    stubFetch({})
    await expect(run(['agents', 'unpublish', 'support-bot'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('unpublishes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/profiles/support-bot/published': () => new Response(null, { status: 204 }),
    })
    await run(['agents', 'unpublish', 'support-bot', '--yes'])
    expect(calls).toHaveLength(1)
  })
})

describe('agents keys', () => {
  it('prints only the token on stdout when piped', async () => {
    stubFetch({
      'POST /api/profiles/support-bot/keys': jsonResponse({
        id: 'key_1',
        token: 'ao_live_secretsecretsecret00',
        label: 'demo',
      }),
    })
    await run(['agents', 'keys', 'create', 'support-bot', '--label', 'demo'])
    expect(stdout()).toBe('ao_live_secretsecretsecret00\n')
  })

  it('lists keys with state', async () => {
    stubFetch({
      'GET /api/profiles/support-bot/keys?limit=10': jsonResponse({
        keys: [
          {
            id: 'key_1',
            label: 'demo',
            createdAt: '2026-07-01T00:00:00Z',
            lastUsedAt: null,
            revokedAt: null,
            expiresAt: null,
          },
        ],
        total: 1,
      }),
    })
    await run(['agents', 'keys', 'list', 'support-bot'])
    expect(stdout()).toBe('key_1\tdemo\t2026-07-01T00:00:00Z\t-\tactive\n')
  })
})

describe('tenant keys', () => {
  it('lists keys in plain mode', async () => {
    stubFetch({
      'GET /api/api-keys': jsonResponse({
        keys: [
          {
            id: 'key_9',
            tenantId: 't',
            name: 'ci',
            role: 'Member',
            createdBy: 'u',
            createdAt: '2026-07-01T00:00:00Z',
          },
        ],
      }),
    })
    await run(['keys', 'list'])
    expect(stdout()).toBe('key_9\tci\tMember\t2026-07-01T00:00:00Z\t-\tactive\n')
  })

  it('creates a key and prints only the token when piped', async () => {
    const calls = stubFetch({
      'POST /api/api-keys': jsonResponse({ id: 'key_2', token: 'ao_dev_newkeynewkeynewkey00', name: 'ci' }),
    })
    await run(['keys', 'create', 'ci'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ name: 'ci' })
    expect(stdout()).toBe('ao_dev_newkeynewkeynewkey00\n')
  })

  it('requires a name in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['keys', 'create'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('revokes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/api-keys/key_9': () => new Response(null, { status: 204 }),
    })
    await run(['keys', 'revoke', 'key_9', '--yes'])
    expect(calls).toHaveLength(1)
  })
})
