import http from 'node:http'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerAuth } from '../../src/commands/auth.js'
import { loadConfig, saveConfig } from '../../src/lib/config.js'
import { DEFAULT_DASHBOARD_URL } from '../../src/lib/defaults.js'
import { ExitCode } from '../../src/lib/errors.js'
import { setBrowserOpener } from '../../src/lib/login-server.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

// Mock the masked paste prompt so the fallback path resolves without a TTY.
vi.mock('../../src/ui/PromptInput.js', () => ({
  promptText: async () => 'ao_dev_abcdefghijklmnopqrstuv',
}))

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// deferred is a promise plus its resolver, for capturing the browser URL the
// login flow hands to the (stubbed) opener.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// httpPostJson POSTs to the loopback callback server, standing in for the
// browser page. Uses node:http (not fetch) so the fetch stub only ever sees
// the CLI's own verify/revoke calls.
function httpPostJson(port: number, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/callback',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        res.on('data', () => {})
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

let cleanup: () => Promise<void>

function makeProgram(): Command {
  const program = new Command()
  program
    .exitOverride()
    .option('--context <name>')
    .option('--api-url <url>')
    .option('--json')
  registerAuth(program)
  return program
}

async function run(args: string[]): Promise<void> {
  await makeProgram().parseAsync(args, { from: 'user' })
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  delete process.env.ORCA_API_KEY
  delete process.env.ORCA_API_URL
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('auth login', () => {
  it('verifies the key and stores it in the context', async () => {
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    await run(['auth', 'login', '--api-url', 'http://test:8080', '--with-token', KEY])

    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('default')
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.apiUrl).toBe('http://test:8080')
  })

  it('rejects a key the server refuses', async () => {
    stubFetch({
      'GET /api/profiles?limit=1': jsonResponse({ error: 'invalid key' }, { status: 401 }),
    })
    await expect(
      run(['auth', 'login', '--api-url', 'http://test:8080', '--with-token', KEY]),
    ).rejects.toMatchObject({ exitCode: ExitCode.Auth })

    const cfg = await loadConfig()
    expect(cfg.contexts.default).toBeUndefined()
  })

  it('writes to a named context via --context', async () => {
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    await run(['--context', 'prod', 'auth', 'login', '--api-url', 'https://prod.example', '--with-token', KEY])

    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('prod')
    expect(cfg.contexts.prod.apiUrl).toBe('https://prod.example')
  })

  it('errors without a token in non-interactive mode', async () => {
    await expect(
      run(['auth', 'login', '--api-url', 'http://test:8080']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('auth status', () => {
  it('reports a valid key', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
    })
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    await run(['auth', 'status'])
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('valid')
  })

  it('fails with the auth exit code when no key is stored', async () => {
    await expect(run(['auth', 'status'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('auth logout', () => {
  it('removes only the key, keeping the context', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
    })
    await run(['auth', 'logout'])
    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBeUndefined()
    expect(cfg.contexts.default.apiUrl).toBe('http://test:8080')
  })

  it('--revoke deletes the stored key on the server, then clears it', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY, keyId: 'key_9' } },
    })
    const calls = stubFetch({
      'DELETE /api/api-keys/key_9': () => new Response(null, { status: 204 }),
    })
    await run(['auth', 'logout', '--revoke'])

    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/api-keys/key_9')).toBe(true)
    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBeUndefined()
    expect(cfg.contexts.default.keyId).toBeUndefined()
    expect(cfg.contexts.default.apiUrl).toBe('http://test:8080')
  })

  it('--revoke still clears locally when the server delete fails', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY, keyId: 'key_9' } },
    })
    stubFetch({
      'DELETE /api/api-keys/key_9': jsonResponse({ error: 'nope' }, { status: 401 }),
    })
    await run(['auth', 'logout', '--revoke'])

    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBeUndefined()
    expect(cfg.contexts.default.keyId).toBeUndefined()
  })

  it('--revoke without a stored key id warns and clears locally, no DELETE', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
    })
    const calls = stubFetch({})
    await run(['auth', 'logout', '--revoke'])

    expect(calls.length).toBe(0)
    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBeUndefined()
  })
})

describe('auth login (browser flow)', () => {
  const savedStdin = process.stdin.isTTY
  const savedStdout = process.stdout.isTTY

  beforeEach(() => {
    // The browser/paste path is interactive-only; fake a TTY on both streams.
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    delete process.env.ORCA_DASHBOARD_URL
  })

  afterEach(() => {
    process.stdin.isTTY = savedStdin
    process.stdout.isTTY = savedStdout
    setBrowserOpener(null)
  })

  it('opens the dashboard, receives the callback, and persists key + keyId + dashboardUrl', async () => {
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    const captured = deferred<string>()
    setBrowserOpener((url) => captured.resolve(url))

    const runPromise = run([
      'auth',
      'login',
      '--api-url',
      'http://test:8080',
      '--dashboard-url',
      'https://dash.example.com',
    ])

    const authUrl = new URL(await captured.promise)
    expect(authUrl.origin + authUrl.pathname).toBe('https://dash.example.com/cli-auth')
    const state = authUrl.searchParams.get('state') ?? ''
    const port = Number(authUrl.searchParams.get('port'))
    expect(state).toMatch(/^[a-f0-9]{64}$/)
    // The key must never travel in the URL.
    expect(authUrl.search).not.toContain('ao_')

    const res = await httpPostJson(port, {
      state,
      key: KEY,
      keyId: 'key_42',
      role: 'admin',
      orgSlug: 'acme',
    })
    expect(res.status).toBe(200)

    await runPromise
    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('default')
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.keyId).toBe('key_42')
    expect(cfg.contexts.default.dashboardUrl).toBe('https://dash.example.com')
    expect(cfg.contexts.default.apiUrl).toBe('http://test:8080')
  })

  it('falls back to the baked-in production dashboard URL when none is configured', async () => {
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    const errors: string[] = []
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => {
      errors.push(a.join(' '))
    })

    await run(['auth', 'login', '--api-url', 'http://test:8080', '--no-browser'])

    const printed = errors.find((l) => l.includes('/cli-auth?'))
    expect(printed).toBeTruthy()
    expect(printed).toContain(String(DEFAULT_DASHBOARD_URL))
  })

  it('accepts a key pasted into the terminal while the browser wait is pending', async () => {
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    const captured = deferred<string>()
    setBrowserOpener((url) => captured.resolve(url))

    // Grant stdin raw-mode powers so the paste listener arms (vitest's stdin
    // is a pipe, which normally has no setRawMode).
    const stdin = process.stdin as unknown as {
      setRawMode?: (v: boolean) => NodeJS.ReadStream
    }
    const hadRawMode = typeof stdin.setRawMode === 'function'
    if (!hadRawMode) stdin.setRawMode = () => process.stdin

    try {
      const runPromise = run([
        'auth',
        'login',
        '--api-url',
        'http://test:8080',
        '--dashboard-url',
        'https://dash.example.com',
      ])
      // Wait until the flow has opened the browser (listener armed by then),
      // then paste the key followed by Enter instead of POSTing the callback.
      await captured.promise
      process.stdin.emit('data', Buffer.from(`${KEY}\r`))
      await runPromise
    } finally {
      if (!hadRawMode) delete stdin.setRawMode
    }

    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    // The paste path carries no key metadata.
    expect(cfg.contexts.default.keyId).toBeUndefined()
  })

  it('--no-browser falls back to a masked paste prompt and stores the key', async () => {
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    const errors: string[] = []
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => {
      errors.push(a.join(' '))
    })

    await run([
      'auth',
      'login',
      '--api-url',
      'http://test:8080',
      '--dashboard-url',
      'https://dash.example.com',
      '--no-browser',
    ])

    // The printed URL must omit the loopback port (reveal-and-paste flow).
    const printed = errors.find((l) => l.includes('/cli-auth?'))
    expect(printed).toBeTruthy()
    expect(printed).not.toContain('port=')

    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.dashboardUrl).toBe('https://dash.example.com')
    expect(cfg.contexts.default.keyId).toBeUndefined()
  })
})
