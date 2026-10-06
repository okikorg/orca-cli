import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyStrict,
  checkApiKeyPresent,
  checkBilling,
  checkColor,
  checkConfigFile,
  checkConfigPermissions,
  checkContext,
  checkDashboard,
  checkKeyRole,
  checkNode,
  checkServer,
  computeFieldSources,
  doctorExitCode,
  gatherContext,
  runDoctor,
  summarize,
  toJsonResults,
  type CheckResult,
  type FetchLike,
} from '../../src/lib/doctor.js'
import { saveConfig } from '../../src/lib/config.js'
import { DEFAULT_API_URL } from '../../src/lib/defaults.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'orca_sk_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmn'

// jsonRes / textRes build Response objects for the injected fetch mocks. These
// never touch global fetch, so Ink's yoga-wasm loader is untouched.
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
function textRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}

// router builds a FetchLike keyed by URL pathname; unmatched paths throw.
function router(map: Record<string, () => Response>): FetchLike {
  return async (url) => {
    const p = new URL(url).pathname
    const h = map[p]
    if (!h) throw new TypeError(`no route for ${p}`)
    return h()
  }
}

// hanging never resolves until its abort signal fires, then rejects like
// AbortSignal.timeout does. Exercises the probe deadline with real timers.
const hanging: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('The operation timed out')
      e.name = 'TimeoutError'
      reject(e)
    })
  })

// networkError models fetch() rejecting because the host is unreachable.
const networkError: FetchLike = async () => {
  throw new TypeError('fetch failed')
}

describe('checkNode', () => {
  it('passes on Node 22+', () => {
    expect(checkNode('22.0.0').status).toBe('pass')
    expect(checkNode('24.9.0').status).toBe('pass')
  })
  it('fails below 22 with an install fix', () => {
    const r = checkNode('20.11.1')
    expect(r.status).toBe('fail')
    expect(r.fix).toContain('Node 22')
  })
})

describe('checkColor', () => {
  it('passes in a TTY with color enabled', () => {
    expect(checkColor({ noColor: false, isTTY: true }).status).toBe('pass')
  })
  it('warns (soft) when not a TTY', () => {
    const r = checkColor({ noColor: false, isTTY: false })
    expect(r.status).toBe('warn')
    expect(r.soft).toBe(true)
  })
  it('warns (soft) when NO_COLOR is set', () => {
    const r = checkColor({ noColor: true, isTTY: true })
    expect(r.status).toBe('warn')
    expect(r.soft).toBe(true)
  })
})

describe('checkConfigFile', () => {
  it('fails only when present but corrupt', () => {
    const r = checkConfigFile({ present: true, parseError: 'bad JSON', path: '/x', envKey: false })
    expect(r.status).toBe('fail')
    expect(r.fix).toContain('/x')
  })
  it('passes when present and parses', () => {
    expect(checkConfigFile({ present: true, path: '/x', envKey: false }).status).toBe('pass')
  })
  it('warns when missing and no env key covers it', () => {
    const r = checkConfigFile({ present: false, path: '/x', envKey: false })
    expect(r.status).toBe('warn')
    expect(r.fix).toContain('orca auth login')
  })
  it('passes when missing but env provides the key (CI)', () => {
    expect(checkConfigFile({ present: false, path: '/x', envKey: true }).status).toBe('pass')
  })
})

describe('checkConfigPermissions', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orca-doctor-perm-'))
  })

  it('fails on a group/world-readable file with a chmod fix', async () => {
    const f = path.join(dir, 'config.json')
    await writeFile(f, '{}', { mode: 0o600 })
    await chmod(f, 0o644)
    const r = await checkConfigPermissions(f)
    expect(r.status).toBe('fail')
    expect(r.message).toContain('644')
    expect(r.fix).toBe(`chmod 600 ${f}`)
  })

  it('passes on an owner-only file', async () => {
    const f = path.join(dir, 'config.json')
    await writeFile(f, '{}', { mode: 0o600 })
    await chmod(f, 0o600)
    expect((await checkConfigPermissions(f)).status).toBe('pass')
  })

  it('skips when there is no file', async () => {
    expect((await checkConfigPermissions(path.join(dir, 'nope.json'))).status).toBe('skip')
  })
})

describe('checkContext', () => {
  it('reports the active context and per-field sources', () => {
    const r = checkContext({
      name: 'prod',
      sources: { apiUrl: 'flag', dashboardUrl: 'default', apiKey: 'file' },
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('active "prod"')
    expect(r.message).toContain('apiUrl=flag')
    expect(r.message).toContain('key=file')
  })

  it('fails when an explicitly named context is unknown', () => {
    const r = checkContext({
      name: 'typpo',
      sources: { apiUrl: 'default', dashboardUrl: 'default', apiKey: 'unset' },
      missing: 'typpo',
      configPath: '/home/ada/.config/orca/config.json',
    })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('context "typpo" not found')
    expect(r.message).toContain('/home/ada/.config/orca/config.json')
    expect(r.fix).toContain('orca context list')
  })
})

describe('computeFieldSources', () => {
  it('labels flag/env/file/default/unset precedence per field', () => {
    const s = computeFieldSources({
      defaulted: new Set(['dashboardUrl']),
      flags: { apiUrl: 'http://flag' },
      env: { ORCA_API_KEY: KEY } as NodeJS.ProcessEnv,
      file: { apiKey: KEY },
    })
    expect(s.apiUrl).toBe('flag')
    expect(s.dashboardUrl).toBe('default')
    expect(s.apiKey).toBe('env')
  })
})

describe('checkServer', () => {
  it('passes with latency on a healthy /health', async () => {
    const r = await checkServer({
      apiUrl: 'http://test:8080',
      fetchImpl: router({ '/health': () => jsonRes({ status: 'ok' }) }),
      timeoutMs: 3000,
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('reachable in')
  })

  it('fails on a non-ok status', async () => {
    const r = await checkServer({
      apiUrl: 'http://test:8080',
      fetchImpl: router({ '/health': () => textRes('nope', 503) }),
      timeoutMs: 3000,
    })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('HTTP 503')
  })

  it('fails with a localhost fix when the local server is down', async () => {
    const r = await checkServer({ apiUrl: 'http://localhost:8080', fetchImpl: networkError, timeoutMs: 3000 })
    expect(r.status).toBe('fail')
    expect(r.fix).toContain('local server')
  })

  it('fails with a remote fix hint for a non-local host', async () => {
    const r = await checkServer({ apiUrl: 'https://api.example.com', fetchImpl: networkError, timeoutMs: 3000 })
    expect(r.fix).toContain('api.example.com')
  })

  it('fails on a timeout', async () => {
    const r = await checkServer({ apiUrl: 'http://test:8080', fetchImpl: hanging, timeoutMs: 20 })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('timed out')
  })

  it('fails without an API URL', async () => {
    expect((await checkServer({ fetchImpl: networkError, timeoutMs: 20 })).status).toBe('fail')
  })
})

describe('checkApiKeyPresent', () => {
  it('passes and masks the key when present', () => {
    const r = checkApiKeyPresent(KEY)
    expect(r.status).toBe('pass')
    expect(r.message).not.toContain(KEY)
  })

  it('fails with a login fix when absent', () => {
    const r = checkApiKeyPresent(undefined)
    expect(r.status).toBe('fail')
    expect(r.fix).toBe('run orca auth login')
  })
})

describe('checkKeyRole', () => {
  const base = { apiUrl: 'http://test:8080', apiKey: KEY, timeoutMs: 3000 }

  it('passes with the role and tenant from /api/whoami', async () => {
    const r = await checkKeyRole({
      ...base,
      fetchImpl: router({ '/api/whoami': () => jsonRes({ tenant: 'org_1', role: 'member' }) }),
    })
    expect(r.status).toBe('pass')
    expect(r.message).toBe('valid; member of org_1')
  })

  it('fails on 401 (invalid/revoked)', async () => {
    const r = await checkKeyRole({ ...base, fetchImpl: router({ '/api/whoami': () => jsonRes({}, 401) }) })
    expect(r.status).toBe('fail')
    expect(r.fix).toBe('run orca auth login')
  })

  it('warns (not fails) on a probe timeout', async () => {
    const r = await checkKeyRole({ ...base, fetchImpl: hanging, timeoutMs: 20 })
    expect(r.status).toBe('warn')
  })

  it('skips when no API key is configured', async () => {
    const r = await checkKeyRole({ ...base, apiKey: undefined, fetchImpl: networkError })
    expect(r.status).toBe('skip')
  })
})

describe('checkBilling', () => {
  const base = { apiUrl: 'http://test:8080', apiKey: KEY, timeoutMs: 3000 }

  it('passes with the formatted balance when the wallet has credit', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({ '/api/billing/wallet': () => jsonRes({ balance_micro_usd: 12_500_000, min_balance_micro_usd: 500_000, paid_work_paused: false, tier: 'pro' }) }),
    })
    expect(r.status).toBe('pass')
    expect(r.message).toBe('credit available (balance $12.50, pro plan)')
  })

  it('warns with a fix when the balance is spent', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ balance_micro_usd: -200, min_balance_micro_usd: 500_000, paid_work_paused: true, tier: 'free' }),
      }),
    })
    expect(r.status).toBe('warn')
    expect(r.fix).toContain('orca billing buy')
  })

  it('takes paused from the server, not from the balance\'s sign', async () => {
    const paused = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ balance_micro_usd: 250_000, min_balance_micro_usd: 500_000, paid_work_paused: true, tier: 'free' }),
      }),
    })
    expect(paused.status).toBe('warn')
    expect(paused.message).toBe("paid work paused (balance $0.25, under the $0.50 minimum); turns on Orca's model keys will be refused")
  })

  it('warns when the wallet lacks the server\'s verdict', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({ '/api/billing/wallet': () => jsonRes({ balance_micro_usd: 12_500_000, tier: 'pro' }) }),
    })
    expect(r.status).toBe('warn')
    expect(r.message).toBe('billing wallet returned an unreadable body')
  })

  it('warns on a server error', async () => {
    const r = await checkBilling({ ...base, fetchImpl: router({ '/api/billing/wallet': () => jsonRes({}, 502) }) })
    expect(r.status).toBe('warn')
  })

  it('warns when the server cannot be reached to check billing', async () => {
    const r = await checkBilling({ ...base, fetchImpl: networkError })
    expect(r.status).toBe('warn')
  })

  it('skips without an API key', async () => {
    const r = await checkBilling({ ...base, apiKey: undefined, fetchImpl: networkError })
    expect(r.status).toBe('skip')
  })
})

describe('checkDashboard', () => {
  it('passes and marks the baked default', () => {
    const r = checkDashboard({ dashboardUrl: 'https://dash', defaulted: true })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('(default)')
  })
  it('warns when unresolved', () => {
    expect(checkDashboard({ dashboardUrl: undefined, defaulted: false }).status).toBe('warn')
  })
})

describe('applyStrict / doctorExitCode / summarize / toJsonResults', () => {
  const results: CheckResult[] = [
    { name: 'a', status: 'pass', message: 'ok' },
    { name: 'b', status: 'warn', message: 'soft', soft: true },
    { name: 'c', status: 'warn', message: 'hard' },
    { name: 'd', status: 'skip', message: 'n/a' },
  ]

  it('promotes only non-soft warns under --strict', () => {
    const strict = applyStrict(results, true)
    expect(strict.find((r) => r.name === 'b')!.status).toBe('warn') // soft stays warn
    expect(strict.find((r) => r.name === 'c')!.status).toBe('fail') // hard warn -> fail
  })

  it('does not mutate without --strict', () => {
    expect(applyStrict(results, false)).toEqual(results)
  })

  it('exit code is 1 only when something failed', () => {
    expect(doctorExitCode(results)).toBe(0)
    expect(doctorExitCode(applyStrict(results, true))).toBe(1)
    expect(doctorExitCode([{ name: 'x', status: 'fail', message: 'no' }])).toBe(1)
  })

  it('summarizes counts by status', () => {
    expect(summarize(results)).toEqual({ pass: 1, warn: 2, fail: 0, skip: 1 })
  })

  it('strips the internal soft flag from JSON output', () => {
    const json = toJsonResults(results)
    expect(json.every((r) => !('soft' in r))).toBe(true)
    // fix is only present when set.
    expect(json[0]).toEqual({ name: 'a', status: 'pass', message: 'ok' })
  })
})

describe('gatherContext', () => {
  let cleanup: () => Promise<void>
  beforeEach(async () => {
    const tmp = await useTmpConfigDir()
    cleanup = tmp.cleanup
    delete process.env.ORCA_API_KEY
    delete process.env.ORCA_API_URL
    delete process.env.ORCA_GATEWAY_URL
    delete process.env.ORCA_DASHBOARD_URL
    delete process.env.ORCA_CONTEXT
  })
  afterEach(async () => {
    await cleanup()
  })

  it('resolves from the config file and marks defaults', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://localhost:8080', apiKey: KEY } },
    })
    const ctx = await gatherContext({}, process.env)
    expect(ctx.apiUrl).toBe('http://localhost:8080')
    expect(ctx.apiKey).toBe(KEY)
    expect(ctx.configPresent).toBe(true)
    expect(ctx.parseError).toBeUndefined()
    expect(ctx.sources.apiUrl).toBe('file')
    // dashboard was not set, so it falls to the baked default.
    expect(ctx.dashboardUrl).toBeTruthy()
    expect(ctx.defaulted.has('dashboardUrl')).toBe(true)
  })

  it('falls back to the prod default apiUrl when nothing is configured', async () => {
    const ctx = await gatherContext({}, process.env)
    expect(ctx.configPresent).toBe(false)
    expect(ctx.apiUrl).toBe(DEFAULT_API_URL)
    expect(ctx.sources.apiUrl).toBe('default')
    expect(ctx.apiKey).toBeUndefined()
  })

  it('flags an unknown explicitly-named context (--context flag)', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://localhost:8080', apiKey: KEY } },
    })
    const ctx = await gatherContext({ context: 'nope' }, process.env)
    expect(ctx.missingContext).toBe('nope')
    // The check turns that into a hard failure.
    const results = await runDoctor({
      ctx,
      env: { ...process.env },
      isTTY: true,
      nodeVersion: '22.0.0',
      fetchImpl: networkError,
      timeoutMs: 20,
    })
    const context = results.find((r) => r.name === 'context')!
    expect(context.status).toBe('fail')
    expect(context.message).toContain('context "nope" not found')
  })

  it('flags an unknown context named via ORCA_CONTEXT', async () => {
    await saveConfig({ contexts: { default: { apiKey: KEY } } })
    process.env.ORCA_CONTEXT = 'ghost'
    try {
      const ctx = await gatherContext({}, process.env)
      expect(ctx.missingContext).toBe('ghost')
    } finally {
      delete process.env.ORCA_CONTEXT
    }
  })

  it('does not flag a known context or an unset context', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiKey: KEY }, prod: { apiKey: KEY } },
    })
    expect((await gatherContext({ context: 'prod' }, process.env)).missingContext).toBeUndefined()
    expect((await gatherContext({}, process.env)).missingContext).toBeUndefined()
  })

  it('does not flag a missing context when env fully overrides (key + url)', async () => {
    const env = { ...process.env, ORCA_API_KEY: KEY, ORCA_API_URL: 'http://test:8080', ORCA_CONTEXT: 'ci' }
    const ctx = await gatherContext({ context: 'ci' }, env)
    expect(ctx.missingContext).toBeUndefined()
  })

  it('records a parseError on a corrupt config without throwing', async () => {
    const { configPath } = await import('../../src/lib/config.js')
    await writeFile(configPath(), '{ this is not json', { mode: 0o600 })
    const ctx = await gatherContext({}, process.env)
    expect(ctx.configPresent).toBe(true)
    expect(ctx.parseError).toBeTruthy()
    // resolution still proceeds from defaults.
    expect(ctx.apiUrl).toBe(DEFAULT_API_URL)
  })
})

describe('runDoctor (orchestration)', () => {
  let cleanup: () => Promise<void>
  beforeEach(async () => {
    const tmp = await useTmpConfigDir()
    cleanup = tmp.cleanup
    delete process.env.ORCA_API_KEY
    delete process.env.ORCA_API_URL
  })
  afterEach(async () => {
    await cleanup()
  })

  it('runs all 10 checks in display order against injected inputs', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY, keyId: 'key_9' } },
    })
    const ctx = await gatherContext({}, process.env)
    const fetchImpl = router({
      '/health': () => jsonRes({ status: 'ok' }),
      '/api/whoami': () => jsonRes({ tenant: 'org_1', role: 'admin' }),
      '/api/billing/wallet': () => jsonRes({ balance_micro_usd: 5_000_000, min_balance_micro_usd: 500_000, paid_work_paused: false, tier: 'free' }),
    })
    const results = await runDoctor({
      ctx,
      env: { ...process.env },
      isTTY: true,
      nodeVersion: '22.0.0',
      fetchImpl,
      timeoutMs: 3000,
    })
    expect(results.map((r) => r.name)).toEqual([
      'node version',
      'color output',
      'config file',
      'config permissions',
      'context',
      'server',
      'api key',
      'api key role',
      'billing',
      'dashboard url',
    ])
    expect(doctorExitCode(results)).toBe(0)
  })
})
