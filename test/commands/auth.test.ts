import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerAuth } from '../../src/commands/auth.js'
import { setBrowserOpener } from '../../src/lib/browser.js'
import { loadConfig, saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch, type RouteHandler } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'orca_sk_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstu'

const WHOAMI = { object: 'whoami', tenant: 'org_1', actor: 'user_1', role: 'admin', agent: null }

let cleanup: () => Promise<void>

// Agent/headless environment markers keep the device flow from opening a
// browser, so tests must pin them: cleared here for deterministic runs (the
// vitest process itself may run under CI or a coding agent), set explicitly
// by the tests that exercise the detection.
const AGENT_ENV_VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'CURSOR_TRACE_ID', 'CI', 'SSH_CONNECTION', 'SSH_TTY'] as const
let savedAgentEnv: Record<string, string | undefined>

const DEVICE_CODE = {
  device_code: 'dc_test_secret',
  user_code: 'BCDF-GHJK',
  verification_uri: 'http://localhost:5173/device',
  verification_uri_complete: 'http://localhost:5173/device?user_code=BCDF-GHJK',
  expires_in: 60,
  interval: 1,
}

// stubDeviceFlow wires the endpoints a full device login touches: code start,
// token poll (pending once, then the given outcome), and the whoami check.
// A 1s interval keeps a full login at ~2s of real sleep.
function stubDeviceFlow(outcome?: RouteHandler) {
  let polls = 0
  return stubFetch({
    'POST /api/device/code': jsonResponse(DEVICE_CODE),
    'POST /api/device/token': (call) => {
      polls++
      if (polls === 1) return jsonResponse({ error: 'authorization_pending' }, { status: 400 })(call)
      if (outcome) return outcome(call)
      return jsonResponse({
        access_token: KEY,
        token_type: 'bearer',
        key_id: 'key_dev',
        role: 'admin',
        tenant_id: 'org_1',
      })(call)
    },
    'GET /api/whoami': jsonResponse(WHOAMI),
  })
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerAuth(program)
  await program.parseAsync(args, { from: 'user' })
}

function stderr(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((c) => c.map(String).join(' '))
    .join('\n')
}

// withTTY fakes a terminal on both streams for one test body.
async function withTTY(fn: () => Promise<void>): Promise<void> {
  const savedStdin = process.stdin.isTTY
  const savedStdout = process.stdout.isTTY
  process.stdin.isTTY = true
  process.stdout.isTTY = true
  try {
    await fn()
  } finally {
    process.stdin.isTTY = savedStdin
    process.stdout.isTTY = savedStdout
  }
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
  setBrowserOpener(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('auth login --with-token', () => {
  it('checks the key with whoami and stores it in the context', async () => {
    stubFetch({ 'GET /api/whoami': jsonResponse(WHOAMI) })
    await run(['auth', 'login', '--api-url', 'http://test:8080', '--with-token', KEY])

    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('default')
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.apiUrl).toBe('http://test:8080')
  })

  it('rejects a key the server refuses and stores nothing', async () => {
    stubFetch({
      'GET /api/whoami': jsonResponse({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, { status: 401 }),
    })
    await expect(run(['auth', 'login', '--api-url', 'http://test:8080', '--with-token', KEY])).rejects.toMatchObject({
      exitCode: ExitCode.Auth,
    })
    const cfg = await loadConfig()
    expect(cfg.contexts.default).toBeUndefined()
  })

  it('writes to a named context via --context', async () => {
    stubFetch({ 'GET /api/whoami': jsonResponse(WHOAMI) })
    await run(['--context', 'prod', 'auth', 'login', '--api-url', 'https://prod.example', '--with-token', KEY])
    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('prod')
    expect(cfg.contexts.prod.apiUrl).toBe('https://prod.example')
  })
})

describe('auth login (device flow)', () => {
  it('polls past authorization_pending and stores the key, key id, and dashboard origin', async () => {
    const calls = stubDeviceFlow()
    await run(['auth', 'login', '--api-url', 'http://test:8080'])

    // The human-relayable lines: code first, then the URL to open.
    expect(stderr()).toContain('BCDF-GHJK')
    expect(stderr()).toContain(DEVICE_CODE.verification_uri_complete)
    // The poll secret must never be printed.
    expect(stderr()).not.toContain('dc_test_secret')

    const token = calls.filter((c) => c.path === '/api/device/token')
    expect(token).toHaveLength(2)
    expect(JSON.parse(token[0].body ?? '{}')).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc_test_secret',
    })

    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBe(KEY)
    expect(cfg.contexts.default.keyId).toBe('key_dev')
    expect(cfg.contexts.default.dashboardUrl).toBe('http://localhost:5173')
  }, 15_000)

  it('opens the verification page for a person at a terminal', async () => {
    const opened: string[] = []
    setBrowserOpener((url) => opened.push(url))
    await withTTY(async () => {
      stubDeviceFlow()
      await run(['auth', 'login', '--api-url', 'http://test:8080'])
    })
    expect(opened).toEqual([DEVICE_CODE.verification_uri_complete])
  }, 15_000)

  it('--no-browser and a coding agent never open a browser', async () => {
    const opened: string[] = []
    setBrowserOpener((url) => opened.push(url))
    await withTTY(async () => {
      stubDeviceFlow()
      await run(['auth', 'login', '--api-url', 'http://test:8080', '--no-browser'])
      process.env.CLAUDECODE = '1'
      const calls = stubDeviceFlow()
      await run(['login', '--api-url', 'http://test:8080'])
      // The login label says which agent drove it.
      expect(calls.find((c) => c.path === '/api/device/code')?.body).toContain('claude-code-')
    })
    expect(opened).toEqual([])
  }, 15_000)

  it('maps access_denied to the auth exit code', async () => {
    stubDeviceFlow(jsonResponse({ error: 'access_denied' }, { status: 400 }))
    await expect(run(['auth', 'login', '--api-url', 'http://test:8080'])).rejects.toMatchObject({
      exitCode: ExitCode.Auth,
      message: expect.stringContaining('denied'),
    })
  }, 15_000)

  it('explains expired_token', async () => {
    stubDeviceFlow(jsonResponse({ error: 'expired_token' }, { status: 400 }))
    await expect(run(['auth', 'login', '--api-url', 'http://test:8080'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: expect.stringContaining('expired'),
    })
  }, 15_000)

  it('explains invalid_grant (a code already used)', async () => {
    stubDeviceFlow(jsonResponse({ error: 'invalid_grant' }, { status: 400 }))
    await expect(run(['auth', 'login', '--api-url', 'http://test:8080'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: expect.stringContaining('already used'),
    })
    const cfg = await loadConfig()
    expect(cfg.contexts.default).toBeUndefined()
  }, 15_000)

  it('explains a server without device login', async () => {
    stubFetch({ 'POST /api/device/code': jsonResponse({ error: { message: 'Resource not found' } }, { status: 404 }) })
    await expect(run(['auth', 'login', '--api-url', 'http://test:8080'])).rejects.toMatchObject({
      message: expect.stringContaining('does not support device login'),
    })
  })

  it('explains the per-address limit on starting logins', async () => {
    stubFetch({
      'POST /api/device/code': jsonResponse({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }),
    })
    await expect(run(['auth', 'login', '--api-url', 'http://test:8080'])).rejects.toMatchObject({
      message: expect.stringContaining('too many login attempts'),
    })
  })
})

describe('auth status', () => {
  it('reports a valid key with its role', async () => {
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } } })
    stubFetch({ 'GET /api/whoami': jsonResponse(WHOAMI) })
    await run(['auth', 'status'])
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('valid, admin')
  })

  it('fails with the auth exit code when no key is stored', async () => {
    await expect(run(['auth', 'status'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('auth logout', () => {
  it('removes only the key, keeping the context', async () => {
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } } })
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
      'DELETE /api/keys/key_9': jsonResponse({ id: 'key_9', object: 'api_key.deleted', deleted: true }),
    })
    await run(['auth', 'logout', '--revoke'])
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/keys/key_9')).toBe(true)
    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBeUndefined()
    expect(cfg.contexts.default.keyId).toBeUndefined()
  })

  it('--revoke still clears locally when the server delete fails', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY, keyId: 'key_9' } },
    })
    stubFetch({ 'DELETE /api/keys/key_9': jsonResponse({ error: { message: 'no' } }, { status: 401 }) })
    await run(['auth', 'logout', '--revoke'])
    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBeUndefined()
  })

  it('--revoke without a stored key id warns and clears locally, no DELETE', async () => {
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } } })
    const calls = stubFetch({})
    await run(['auth', 'logout', '--revoke'])
    expect(calls.length).toBe(0)
    const cfg = await loadConfig()
    expect(cfg.contexts.default.apiKey).toBeUndefined()
  })
})

describe('whoami', () => {
  beforeEach(async () => {
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } } })
  })

  it('reports tenant, actor, and role from the server, top level and under auth', async () => {
    stubFetch({ 'GET /api/whoami': jsonResponse(WHOAMI) })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run(['--json', 'whoami'])
    await run(['--json', 'auth', 'whoami'])
    const outputs = write.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
    expect(outputs).toHaveLength(2)
    for (const out of outputs) {
      expect(out).toMatchObject({ tenant: 'org_1', actor: 'user_1', role: 'admin', agent: null })
      expect(String(out.apiKey)).not.toContain(KEY)
    }
  })

  it('names the agent a published key is scoped to', async () => {
    stubFetch({ 'GET /api/whoami': jsonResponse({ ...WHOAMI, role: 'member', agent: 'agent_1' }) })
    await run(['whoami'])
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Agent:    agent_1')
  })

  it('fails with the auth exit code when no key is stored', async () => {
    await saveConfig({ currentContext: 'default', contexts: {} })
    await expect(run(['whoami'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})
