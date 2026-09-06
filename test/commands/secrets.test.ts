import { Readable } from 'node:stream'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerSecrets } from '../../src/commands/secrets.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'
const SECRET = 'sk-super-secret-value-9f8e7d6c'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerSecrets(program)
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
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
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

// allOutput joins every sink a value could conceivably leak through: stdout
// (printJson), stderr, and both console channels used for hints/success.
function allOutput(): string {
  const outWrites = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]))
  const errWrites = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]))
  const logs = vi.mocked(console.log).mock.calls.map((c) => c.map(String).join(' '))
  const errs = vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' '))
  return [...outWrites, ...errWrites, ...logs, ...errs].join('\n')
}

describe('secrets list', () => {
  it('emits raw secret metadata with --json and sends the default limit', async () => {
    const calls = stubFetch({
      'GET /api/secrets?limit=10': jsonResponse({
        total: 1,
        secrets: [
          { name: 'ANTHROPIC_API_KEY', key: 'ANTHROPIC_API_KEY', algorithm: 'xchacha20poly1305', createdAt: 't', updatedAt: 't2' },
        ],
      }),
    })
    await run(['--json', 'secrets', 'list'])
    expect(JSON.parse(stdout())).toEqual([
      { name: 'ANTHROPIC_API_KEY', key: 'ANTHROPIC_API_KEY', algorithm: 'xchacha20poly1305', createdAt: 't', updatedAt: 't2' },
    ])
    expect(calls[0].path).toBe('/api/secrets?limit=10')
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/secrets?limit=10': jsonResponse({
        total: 2,
        secrets: [
          { name: 'A', key: 'AWS', description: 'aws key', algorithm: 'xchacha20poly1305', createdAt: 't', updatedAt: 'u1' },
          { name: 'B', algorithm: 'xchacha20poly1305', createdAt: 't', updatedAt: 'u2' },
        ],
      }),
    })
    await run(['secrets', 'list'])
    expect(stdout()).toBe(
      'A\tAWS\txchacha20poly1305\tu1\taws key\n' + 'B\t-\txchacha20poly1305\tu2\t-\n',
    )
  })

  it('forwards --limit/--offset and hints on stderr when the server has more', async () => {
    const calls = stubFetch({
      'GET /api/secrets?limit=1&offset=2': jsonResponse(
        {
          total: 5,
          secrets: [
            { name: 'A', key: 'AWS', algorithm: 'xchacha20poly1305', createdAt: 't', updatedAt: 'u1' },
          ],
        },
        { headers: { 'X-Total-Count': '5' } },
      ),
    })
    await run(['secrets', 'list', '--limit', '1', '--offset', '2'])
    expect(calls[0].path).toBe('/api/secrets?limit=1&offset=2')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 5')
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({ 'GET /api/secrets?limit=10': jsonResponse({ error: 'bad key' }, { status: 401 }) })
    await expect(run(['secrets', 'list'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })

  it('hints the set command on an empty list (stderr only)', async () => {
    stubFetch({ 'GET /api/secrets?limit=10': jsonResponse({ total: 0, secrets: [] }) })
    await run(['secrets', 'list'])
    expect(stdout()).toBe('')
    const errText = vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(errText).toContain('No secrets')
    expect(errText).toContain('orca secrets set')
  })
})

describe('secrets set', () => {
  // The metadata read behind `set` walks the list (there is no GET by name),
  // so every set that omits --key or --description hits this route first.
  const LIST_ROUTE = 'GET /api/secrets?limit=200'
  const putMeta = (extra: Record<string, string> = {}) =>
    jsonResponse({
      name: 'apikey',
      algorithm: 'xchacha20poly1305',
      createdAt: 't',
      updatedAt: 't',
      ...extra,
    })
  const existingRow = {
    name: 'apikey',
    key: 'ANTHROPIC_API_KEY',
    description: 'prod anthropic key',
    algorithm: 'xchacha20poly1305',
    createdAt: 't',
    updatedAt: 't',
  }
  const putCall = (calls: { method: string; body?: string }[]) => calls.find((c) => c.method === 'PUT')!

  it('PUTs the plaintext in the request body from --value', async () => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ total: 0, secrets: [] }),
      'PUT /api/secrets/apikey': putMeta(),
    })
    await run(['secrets', 'set', 'apikey', '--value', SECRET, '--key', 'ANTHROPIC_API_KEY'])
    const put = putCall(calls)
    expect(JSON.parse(put.body ?? '{}')).toEqual({ plaintext: SECRET, key: 'ANTHROPIC_API_KEY' })
  })

  it('carries the existing key and description forward when the flags are omitted', async () => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ total: 1, secrets: [existingRow] }),
      'PUT /api/secrets/apikey': putMeta({ key: existingRow.key, description: existingRow.description }),
    })
    await run(['secrets', 'set', 'apikey', '--value', SECRET])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST_ROUTE, 'PUT /api/secrets/apikey'])
    expect(JSON.parse(putCall(calls).body ?? '{}')).toEqual({
      plaintext: SECRET,
      key: 'ANTHROPIC_API_KEY',
      description: 'prod anthropic key',
    })
    expect(allOutput()).not.toContain(SECRET)
  })

  it('lets an explicit flag override one field while carrying the other', async () => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ total: 1, secrets: [existingRow] }),
      'PUT /api/secrets/apikey': putMeta(),
    })
    await run(['secrets', 'set', 'apikey', '--value', SECRET, '--description', 'rotated'])
    expect(JSON.parse(putCall(calls).body ?? '{}')).toEqual({
      plaintext: SECRET,
      key: 'ANTHROPIC_API_KEY',
      description: 'rotated',
    })
  })

  it('clears a field when the flag is passed empty', async () => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ total: 1, secrets: [existingRow] }),
      'PUT /api/secrets/apikey': putMeta(),
    })
    await run(['secrets', 'set', 'apikey', '--value', SECRET, '--key', ''])
    expect(JSON.parse(putCall(calls).body ?? '{}')).toEqual({
      plaintext: SECRET,
      description: 'prod anthropic key',
    })
  })

  it('creates without carrying anything when the secret does not exist yet', async () => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ total: 1, secrets: [{ ...existingRow, name: 'other' }] }),
      'PUT /api/secrets/apikey': putMeta(),
    })
    await run(['secrets', 'set', 'apikey', '--value', SECRET])
    expect(JSON.parse(putCall(calls).body ?? '{}')).toEqual({ plaintext: SECRET })
  })

  it('skips the metadata read when both --key and --description are given', async () => {
    const calls = stubFetch({ 'PUT /api/secrets/apikey': putMeta() })
    await run(['secrets', 'set', 'apikey', '--value', SECRET, '--key', 'K', '--description', 'd'])
    expect(calls.map((c) => c.method)).toEqual(['PUT'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ plaintext: SECRET, key: 'K', description: 'd' })
  })

  it('does not write when the metadata read fails', async () => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ error: 'secrets store not configured' }, { status: 503 }),
    })
    await expect(run(['secrets', 'set', 'apikey', '--value', SECRET])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
    })
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined()
    expect(allOutput()).not.toContain(SECRET)
  })

  // The hard rule: the value must reach the request body but never appear on
  // stdout or stderr in ANY output mode.
  it.each([
    ['json', ['--json', 'secrets', 'set', 'apikey', '--value', SECRET]],
    ['plain', ['secrets', 'set', 'apikey', '--value', SECRET]],
  ])('never prints the value in %s mode', async (_mode, args) => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ total: 1, secrets: [existingRow] }),
      'PUT /api/secrets/apikey': putMeta(),
    })
    await run(args)
    // Proof the value WAS sent:
    expect(JSON.parse(putCall(calls).body ?? '{}').plaintext).toBe(SECRET)
    // Proof it never leaked to any output sink:
    expect(allOutput()).not.toContain(SECRET)
  })

  it('never prints the value in TTY (ink) mode', async () => {
    const prevOut = process.stdout.isTTY
    const prevIn = process.stdin.isTTY
    process.stdout.isTTY = true
    process.stdin.isTTY = true
    try {
      const calls = stubFetch({
        [LIST_ROUTE]: jsonResponse({ total: 0, secrets: [] }),
        'PUT /api/secrets/apikey': putMeta(),
      })
      await run(['secrets', 'set', 'apikey', '--value', SECRET])
      expect(JSON.parse(putCall(calls).body ?? '{}').plaintext).toBe(SECRET)
      expect(allOutput()).not.toContain(SECRET)
    } finally {
      process.stdout.isTTY = prevOut
      process.stdin.isTTY = prevIn
    }
  })

  it('reads the value from piped stdin and strips one trailing newline', async () => {
    const calls = stubFetch({
      [LIST_ROUTE]: jsonResponse({ total: 0, secrets: [] }),
      'PUT /api/secrets/apikey': putMeta(),
    })
    const real = process.stdin
    const fake = Readable.from([Buffer.from(SECRET + '\n')])
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true })
    try {
      await run(['secrets', 'set', 'apikey'])
    } finally {
      Object.defineProperty(process, 'stdin', { value: real, configurable: true, writable: true })
    }
    expect(JSON.parse(putCall(calls).body ?? '{}').plaintext).toBe(SECRET)
    expect(allOutput()).not.toContain(SECRET)
  })

  it('rejects an empty --value as a usage error', async () => {
    const calls = stubFetch({})
    await expect(run(['secrets', 'set', 'apikey', '--value', ''])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('secrets delete', () => {
  it('refuses without --yes when not interactive', async () => {
    stubFetch({})
    await expect(run(['secrets', 'delete', 'apikey'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/secrets/apikey': jsonResponse({ name: 'apikey', deleted: true }),
    })
    await run(['secrets', 'delete', 'apikey', '--yes'])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'DELETE /api/secrets/ghost': jsonResponse({ error: 'secret not found' }, { status: 404 }),
    })
    await expect(run(['secrets', 'delete', 'ghost', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})
