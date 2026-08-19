import http from 'node:http'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerAuth } from '../../src/commands/auth.js'
import { loadConfig, maskKey, saveConfig } from '../../src/lib/config.js'
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

// Agent/headless environment markers auto-select the device flow, so tests
// must pin them: cleared here for deterministic runs (the vitest process
// itself may run under CI or a coding agent), set explicitly by the tests
// that exercise the detection.
const AGENT_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CURSOR_TRACE_ID',
  'CI',
  'SSH_CONNECTION',
  'SSH_TTY',
] as const
let savedAgentEnv: Record<string, string | undefined>

// stubDeviceFlow wires the three endpoints a full device login touches:
// code mint, token poll (pending once, then success), and the verify probe.
// interval 0 clamps to 1s in the poller, so a test costs ~2s of real sleep.
function stubDeviceFlow() {
  let polls = 0
  return stubFetch({
    'POST /api/device/code': jsonResponse({
      device_code: 'dc_test_secret',
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://app.orcapods.ai/cli-auth',
      verification_uri_complete: 'https://app.orcapods.ai/cli-auth?code=BCDF-GHJK',
      expires_in: 60,
      interval: 0,
    }),
    'POST /api/device/token': (call) => {
      polls++
      if (polls === 1) return jsonResponse({ error: 'authorization_pending' }, { status: 400 })(call)
      return jsonResponse({
        access_token: KEY,
        token_type: 'bearer',
        key_id: 'key_dev',
        role: 'member',
        org_slug: 'acme',
        tenant_id: 'org_1',
      })(call)
    },
    'GET /api/profiles?limit=1': jsonResponse([]),
  })
}

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
  savedAgentEnv = {}
  for (const key of AGENT_ENV_VARS) {
    savedAgentEnv[key] = process.env[key]
    delete process.env[key]
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await cleanup()
  for (const key of AGENT_ENV_VARS) {
    if (savedAgentEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedAgentEnv[key]
  }
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

  it('runs the device flow end-to-end in non-interactive mode', async () => {
    // The old contract errored here ("browser login needs an interactive
    // terminal"); headless logins now self-serve via the device flow. This
    // is the path a coding agent takes when it runs `orca login`.
    stubDeviceFlow()
    const errors: string[] = []
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => {
      errors.push(a.join(' '))
    })

    await run(['auth', 'login', '--api-url', 'http://test:8080'])

    // The human-relayable lines: code first, then the URL to open.
    const out = errors.join('\n')
    expect(out).toContain('BCDF-GHJK')
    expect(out).toContain('https://app.orcapods.ai/cli-auth?code=BCDF-GHJK')
    // The poll secret must never be printed.
    expect(out).not.toContain('dc_test_secret')

    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.keyId).toBe('key_dev')
  }, 15_000)

  it('an agent environment marker selects the device flow even with a TTY', async () => {
    const savedStdin = process.stdin.isTTY
    const savedStdout = process.stdout.isTTY
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    process.env.CLAUDECODE = '1'
    try {
      const calls = stubDeviceFlow()
      await run(['auth', 'login', '--api-url', 'http://test:8080'])
      expect(calls.some((c) => c.path === '/api/device/code')).toBe(true)
      // The minted key label says which agent drove the login.
      const codeCall = calls.find((c) => c.path === '/api/device/code')
      expect(codeCall?.body).toContain('claude-code-')
      const cfg = await loadConfig()
      expect(cfg.contexts.default.apiKey).toBe(KEY)
    } finally {
      process.stdin.isTTY = savedStdin
      process.stdout.isTTY = savedStdout
    }
  }, 15_000)

  it('maps a dashboard denial to the auth exit code', async () => {
    stubFetch({
      'POST /api/device/code': jsonResponse({
        device_code: 'dc',
        user_code: 'BCDF-GHJK',
        verification_uri: 'https://app.orcapods.ai/cli-auth',
        verification_uri_complete: 'https://app.orcapods.ai/cli-auth?code=BCDF-GHJK',
        expires_in: 60,
        interval: 0,
      }),
      'POST /api/device/token': jsonResponse({ error: 'access_denied' }, { status: 400 }),
    })
    await expect(
      run(['auth', 'login', '--api-url', 'http://test:8080']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  }, 15_000)

  it('explains when the conductor predates device login', async () => {
    stubFetch({
      'POST /api/device/code': jsonResponse({ error: 'not found' }, { status: 404 }),
    })
    await expect(
      run(['auth', 'login', '--api-url', 'http://test:8080']),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not support headless login'),
    })
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

  it('--revoke --yes bypasses the TTY confirm and revokes (no Ink mount)', async () => {
    // Fake a TTY on both streams so interactive() is true; --yes must still
    // short-circuit the confirm so no Ink component is ever mounted.
    const savedStdin = process.stdin.isTTY
    const savedStdout = process.stdout.isTTY
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    try {
      await saveConfig({
        currentContext: 'default',
        contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY, keyId: 'key_9' } },
      })
      const calls = stubFetch({
        'DELETE /api/api-keys/key_9': () => new Response(null, { status: 204 }),
      })
      await run(['auth', 'logout', '--revoke', '--yes'])

      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/api-keys/key_9')).toBe(true)
      const cfg = await loadConfig()
      expect(cfg.contexts.default.apiKey).toBeUndefined()
      expect(cfg.contexts.default.keyId).toBeUndefined()
    } finally {
      process.stdin.isTTY = savedStdin
      process.stdout.isTTY = savedStdout
    }
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
    const output = [
      ...vi.mocked(console.log).mock.calls.flat(),
      ...vi.mocked(console.error).mock.calls.flat(),
    ].join('\n')
    expect(output).toContain('Logged in')
    expect(output).not.toContain('http://test:8080')
    expect(output).not.toContain(maskKey(KEY))
    expect(output).not.toContain('/cli-auth?')
    expect(output).not.toContain('config.json')
    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('default')
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.keyId).toBe('key_42')
    expect(cfg.contexts.default.dashboardUrl).toBe('https://dash.example.com')
    expect(cfg.contexts.default.apiUrl).toBe('http://test:8080')
  })

  // completeBrowserLogin captures the URL handed to the (stubbed) browser
  // opener, POSTs the callback like the dashboard page would, and returns
  // the captured URL. Shared by the dashboard-URL resolution tests, which
  // used to observe the URL via --no-browser before that flag was repointed
  // at the device flow.
  async function completeBrowserLogin(runPromise: Promise<void>, captured: Promise<string>): Promise<URL> {
    const authUrl = new URL(await captured)
    const state = authUrl.searchParams.get('state') ?? ''
    const port = Number(authUrl.searchParams.get('port'))
    await httpPostJson(port, { state, key: KEY, keyId: 'key_42', role: 'admin', orgSlug: 'acme' })
    await runPromise
    return authUrl
  }

  it('falls back to the baked-in production dashboard URL when none is configured', async () => {
    expect(DEFAULT_DASHBOARD_URL).toBe('https://app.orcapods.ai')
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    const captured = deferred<string>()
    setBrowserOpener((url) => captured.resolve(url))

    const authUrl = await completeBrowserLogin(
      run(['auth', 'login', '--api-url', 'http://test:8080']),
      captured.promise,
    )
    expect(authUrl.origin + authUrl.pathname).toBe('https://app.orcapods.ai/cli-auth')
  })

  it('upgrades the former baked-in dashboard URL saved in a context', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: {
        default: { dashboardUrl: 'https://agent-orc-dashboard.vercel.app' },
      },
    })
    stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
    const captured = deferred<string>()
    setBrowserOpener((url) => captured.resolve(url))

    const authUrl = await completeBrowserLogin(
      run(['auth', 'login', '--api-url', 'http://test:8080']),
      captured.promise,
    )
    expect(authUrl.origin).toBe('https://app.orcapods.ai')
    expect((await loadConfig()).contexts.default.dashboardUrl).toBe('https://app.orcapods.ai')
  })

  it('upgrades the former dashboard URL from an existing shell override', async () => {
    process.env.ORCA_DASHBOARD_URL = 'https://agent-orc-dashboard.vercel.app/'
    try {
      stubFetch({ 'GET /api/profiles?limit=1': jsonResponse([]) })
      const captured = deferred<string>()
      setBrowserOpener((url) => captured.resolve(url))

      const authUrl = await completeBrowserLogin(
        run(['auth', 'login', '--api-url', 'http://test:8080']),
        captured.promise,
      )
      expect(authUrl.origin).toBe('https://app.orcapods.ai')
    } finally {
      delete process.env.ORCA_DASHBOARD_URL
    }
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

  it('--no-browser and --headless run the device flow despite the TTY', async () => {
    // --no-browser used to print a reveal-and-paste URL; it now aliases the
    // device flow (strictly better: no key ever crosses a paste buffer).
    const calls = stubDeviceFlow()
    await run([
      'auth',
      'login',
      '--api-url',
      'http://test:8080',
      '--no-browser',
    ])
    expect(calls.some((c) => c.path === '/api/device/code')).toBe(true)
    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.keyId).toBe('key_dev')
  }, 15_000)

  it('the top-level `orca login --headless` alias works end-to-end', async () => {
    const calls = stubDeviceFlow()
    await run(['login', '--api-url', 'http://test:8080', '--headless'])
    expect(calls.some((c) => c.path === '/api/device/code')).toBe(true)
    expect((await loadConfig()).contexts.default.apiKey).toBe(KEY)
  }, 15_000)
})

describe('whoami', () => {
  it('reports tenant, role, and key id from the server', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
    })
    stubFetch({
      'GET /api/whoami': jsonResponse({
        tenantId: 'org_1',
        tenantName: 'Acme',
        role: 'member',
        authKind: 'api_key',
        keyId: 'key_dev',
      }),
    })
    const logs: string[] = []
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '))
    })
    await run(['whoami'])
    const out = logs.join('\n')
    expect(out).toContain('Acme')
    expect(out).toContain('org_1')
    expect(out).toContain('member')
    expect(out).toContain('key_dev')
  })

  it('degrades to a local summary against conductors without /api/whoami', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
    })
    stubFetch({
      'GET /api/whoami': jsonResponse({ error: 'not found' }, { status: 404 }),
      'GET /api/profiles?limit=1': jsonResponse([]),
    })
    const logs: string[] = []
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '))
    })
    await run(['whoami'])
    expect(logs.join('\n')).toContain('predates /api/whoami')
  })

  it('fails with the auth exit code when no key is stored', async () => {
    await expect(run(['whoami'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})
