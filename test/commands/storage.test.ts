import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerStorage } from '../../src/commands/storage.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// Mirrors agent-runtime/runtime/httpapi/storage.go response shapes.
const INFO = {
  configured: true,
  bucket: 'orca-storage',
  usedBytes: 1048576,
  objectCount: 12,
  capacityBytes: 10485760,
  breakdown: [{ prefix: 'runs/', bytes: 1048576, count: 12 }],
}

const LIST = {
  prefix: 'runs/',
  bucket: 'orca-storage',
  entries: [
    { key: 'runs/r1/out.txt', size: 42, lastModified: '2026-07-01T09:00:00Z', etag: 'e1' },
    { key: 'runs/r1/log.json', size: 1024, lastModified: '2026-07-02T10:30:00Z' },
  ],
  count: 2,
}

let cleanup: () => Promise<void>
let tmpDir: string
const realIsTTY = process.stdout.isTTY

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerStorage(program)
  await program.parseAsync(args, { from: 'user' })
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  tmpDir = tmp.dir
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
  process.stdout.isTTY = realIsTTY
})

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .join('')
}

// Reconstruct the exact bytes written to stdout, preserving Buffer fidelity.
function stdoutBuffer(): Buffer {
  const parts = vi.mocked(process.stdout.write).mock.calls.map((c) => {
    const a = c[0] as unknown
    if (Buffer.isBuffer(a)) return a
    if (a instanceof Uint8Array) return Buffer.from(a)
    return Buffer.from(String(a), 'utf8')
  })
  return Buffer.concat(parts)
}

describe('storage info', () => {
  it('emits the raw payload with --json', async () => {
    stubFetch({ 'GET /api/storage/info': jsonResponse(INFO) })
    await run(['--json', 'storage', 'info'])
    expect(JSON.parse(stdout())).toEqual(INFO)
  })

  it('prints field rows (raw bytes) in plain mode', async () => {
    stubFetch({ 'GET /api/storage/info': jsonResponse(INFO) })
    await run(['storage', 'info'])
    expect(stdout()).toBe(
      'bucket\torca-storage\n' + 'usedBytes\t1048576\n' + 'objectCount\t12\n' + 'capacityBytes\t10485760\n',
    )
  })

  it('reports a not-configured bucket without failing', async () => {
    stubFetch({ 'GET /api/storage/info': jsonResponse({ configured: false, usedBytes: 0, objectCount: 0 }) })
    await run(['storage', 'info'])
    expect(stdout()).toBe('')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('not configured')
  })
})

describe('storage ls', () => {
  it('emits the raw listing with --json', async () => {
    stubFetch({ 'GET /api/storage/objects?prefix=runs%2F': jsonResponse(LIST) })
    await run(['--json', 'storage', 'ls', 'runs/'])
    expect(JSON.parse(stdout())).toEqual(LIST)
  })

  it('prints tab-separated rows (raw size) in plain mode', async () => {
    stubFetch({ 'GET /api/storage/objects': jsonResponse(LIST) })
    await run(['storage', 'ls'])
    expect(stdout()).toBe(
      'runs/r1/out.txt\t42\t2026-07-01 09:00\n' + 'runs/r1/log.json\t1024\t2026-07-02 10:30\n',
    )
  })

  it('passes limit through as a query param', async () => {
    const calls = stubFetch({ 'GET /api/storage/objects?prefix=runs%2F&limit=5': jsonResponse(LIST) })
    await run(['--json', 'storage', 'ls', 'runs/', '--limit', '5'])
    expect(calls[0].path).toBe('/api/storage/objects?prefix=runs%2F&limit=5')
  })

  it('validates the listing limit', async () => {
    await expect(run(['storage', 'ls', '--limit', '0'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    await expect(run(['storage', 'ls', '--limit', '1001'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('hints an empty state with no entries', async () => {
    stubFetch({ 'GET /api/storage/objects': jsonResponse({ prefix: '', bucket: 'b', entries: [], count: 0 }) })
    await run(['storage', 'ls'])
    expect(stdout()).toBe('')
    const errText = vi.mocked(console.error).mock.calls.join(' ')
    expect(errText).toContain('No objects')
    // The empty state names the command that uploads the missing thing.
    expect(errText).toContain('orca storage put')
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({ 'GET /api/storage/objects': jsonResponse({ error: 'unauthorized' }, { status: 401 }) })
    await expect(run(['storage', 'ls'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('storage browse', () => {
  it('requires an interactive terminal and points scripts to storage ls', async () => {
    await expect(run(['storage', 'browse'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
      message: 'storage browse requires an interactive terminal',
    })
  })
})

describe('storage get', () => {
  it('streams UTF-8 text bytes to stdout when piped', async () => {
    stubFetch({
      'GET /api/storage/objects/notes/a.txt': jsonResponse({
        key: 'notes/a.txt',
        size: 11,
        encoding: 'text',
        content: 'hello world',
      }),
    })
    await run(['storage', 'get', 'notes/a.txt'])
    expect(stdoutBuffer().toString('utf8')).toBe('hello world')
  })

  it('decodes base64 binary to exact bytes when piped', async () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f])
    stubFetch({
      'GET /api/storage/objects/blob.bin': jsonResponse({
        key: 'blob.bin',
        size: bin.length,
        contentType: 'application/octet-stream',
        encoding: 'base64',
        content: bin.toString('base64'),
      }),
    })
    await run(['storage', 'get', 'blob.bin'])
    expect(stdoutBuffer().equals(bin)).toBe(true)
  })

  it('encodes key segments but keeps slashes literal', async () => {
    const calls = stubFetch({
      'GET /api/storage/objects/a/b%20c/d.txt': jsonResponse({
        key: 'a/b c/d.txt',
        size: 1,
        encoding: 'text',
        content: 'x',
      }),
    })
    await run(['storage', 'get', 'a/b c/d.txt'])
    expect(calls[0].path).toBe('/api/storage/objects/a/b%20c/d.txt')
  })

  it('writes exact bytes to --output and leaves stdout empty', async () => {
    const bin = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00])
    stubFetch({
      'GET /api/storage/objects/blob.bin': jsonResponse({
        key: 'blob.bin',
        size: bin.length,
        encoding: 'base64',
        content: bin.toString('base64'),
      }),
    })
    const out = path.join(tmpDir, 'out.bin')
    await run(['storage', 'get', 'blob.bin', '--output', out])
    expect(stdout()).toBe('')
    expect((await readFile(out)).equals(bin)).toBe(true)
  })

  it('refuses to dump binary to a TTY without --output', async () => {
    process.stdout.isTTY = true
    const bin = Buffer.from([0x00, 0x01, 0x02])
    stubFetch({
      'GET /api/storage/objects/blob.bin': jsonResponse({
        key: 'blob.bin',
        size: bin.length,
        encoding: 'base64',
        content: bin.toString('base64'),
      }),
    })
    await expect(run(['storage', 'get', 'blob.bin'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(stdoutBuffer().length).toBe(0)
  })

  it('emits the raw JSON object with --json', async () => {
    const obj = { key: 'notes/a.txt', size: 5, encoding: 'text', content: 'hello' }
    stubFetch({ 'GET /api/storage/objects/notes/a.txt': jsonResponse(obj) })
    await run(['--json', 'storage', 'get', 'notes/a.txt'])
    expect(JSON.parse(stdout())).toEqual(obj)
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({ 'GET /api/storage/objects/missing': jsonResponse({ error: 'not found' }, { status: 404 }) })
    await expect(run(['storage', 'get', 'missing'])).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })
})

describe('storage put', () => {
  it('uploads the raw file bytes with a guessed Content-Type', async () => {
    const bytes = Buffer.from('name,age\nada,36\n', 'utf8')
    const src = path.join(tmpDir, 'people.csv')
    await writeFile(src, bytes)

    let captured: { body?: unknown; headers?: Record<string, string>; method?: string; pathname?: string } = {}
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      captured = {
        body: init?.body,
        headers: init?.headers as Record<string, string>,
        method: init?.method,
        pathname: url.pathname,
      }
      return new Response(JSON.stringify({ key: 'up/people.csv', size: bytes.length, etag: 'e9' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await run(['storage', 'put', 'up/people.csv', src])
    expect(captured.method).toBe('PUT')
    expect(captured.pathname).toBe('/api/storage/objects/up/people.csv')
    expect(captured.headers?.['Content-Type']).toBe('text/csv')
    expect(Buffer.isBuffer(captured.body)).toBe(true)
    expect((captured.body as Buffer).equals(bytes)).toBe(true)
  })

  it('honors an explicit --content-type override', async () => {
    const src = path.join(tmpDir, 'data')
    await writeFile(src, Buffer.from([1, 2, 3]))
    const calls = stubFetch({
      'PUT /api/storage/objects/x/data': jsonResponse({ key: 'x/data', size: 3 }),
    })
    await run(['storage', 'put', 'x/data', src, '--content-type', 'application/x-thing'])
    expect(calls[0].headers['Content-Type']).toBe('application/x-thing')
  })

  it('rejects a key ending in slash', async () => {
    const src = path.join(tmpDir, 'data')
    await writeFile(src, Buffer.from([1]))
    await expect(run(['storage', 'put', 'folder/', src])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('fails with a usage error on a missing local file', async () => {
    await expect(run(['storage', 'put', 'k', path.join(tmpDir, 'nope')])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })
})

describe('storage rm', () => {
  it('deletes an object with --yes and reports the count', async () => {
    const calls = stubFetch({
      'DELETE /api/storage/objects/runs/r1/out.txt': jsonResponse({ key: 'runs/r1/out.txt', deleted: 1 }),
    })
    await run(['storage', 'rm', 'runs/r1/out.txt', '--yes'])
    expect(calls[0].method).toBe('DELETE')
    expect(vi.mocked(console.log).mock.calls.join(' ')).toContain('Deleted 1 object')
  })

  it('preserves a trailing slash for prefix deletes', async () => {
    const calls = stubFetch({
      'DELETE /api/storage/objects/runs/r1/': jsonResponse({ key: 'runs/r1/', deleted: 7 }),
    })
    await run(['--json', 'storage', 'rm', 'runs/r1/', '--yes'])
    expect(calls[0].path).toBe('/api/storage/objects/runs/r1/')
    expect(JSON.parse(stdout())).toEqual({ key: 'runs/r1/', deleted: 7 })
  })

  it('refuses to delete without --yes in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['storage', 'rm', 'k'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})
