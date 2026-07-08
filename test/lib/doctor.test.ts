import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyStrict,
  checkApiKeyPresent,
  checkBilling,
  checkColor,
  checkConductor,
  checkConfigFile,
  checkConfigPermissions,
  checkContext,
  checkDashboard,
  checkGateway,
  checkKeyRole,
  checkNode,
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

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

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
      sources: { apiUrl: 'flag', gatewayUrl: 'unset', dashboardUrl: 'default', apiKey: 'file' },
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('active "prod"')
    expect(r.message).toContain('apiUrl=flag')
    expect(r.message).toContain('key=file')
  })

  it('fails when an explicitly named context is unknown', () => {
    const r = checkContext({
      name: 'typpo',
      sources: { apiUrl: 'default', gatewayUrl: 'default', dashboardUrl: 'default', apiKey: 'unset' },
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
      file: { gatewayUrl: 'http://gw' },
    })
    expect(s.apiUrl).toBe('flag')
    expect(s.gatewayUrl).toBe('file')
    expect(s.dashboardUrl).toBe('default')
    expect(s.apiKey).toBe('env')
  })
})

describe('checkConductor', () => {
  it('passes with latency on a healthy /healthz', async () => {
    const r = await checkConductor({
      apiUrl: 'http://test:8080',
      fetchImpl: router({ '/healthz': () => textRes('ok') }),
      timeoutMs: 3000,
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('HTTP 200')
  })

  it('fails on a non-ok status', async () => {
    const r = await checkConductor({
      apiUrl: 'http://test:8080',
      fetchImpl: router({ '/healthz': () => textRes('nope', 503) }),
      timeoutMs: 3000,
    })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('503')
  })

  it('fails with a localhost fix when the local conductor is down', async () => {
    const r = await checkConductor({
      apiUrl: 'http://localhost:8080',
      fetchImpl: networkError,
      timeoutMs: 3000,
    })
    expect(r.status).toBe('fail')
    expect(r.fix).toContain('local conductor')
  })

  it('fails with a remote fix hint for a non-local host', async () => {
    const r = await checkConductor({
      apiUrl: 'https://conductor.example.com',
      fetchImpl: networkError,
      timeoutMs: 3000,
    })
    expect(r.status).toBe('fail')
    expect(r.fix).toContain('conductor.example.com')
  })

  it('fails on a timeout (hard fail for check 6)', async () => {
    const r = await checkConductor({ apiUrl: 'http://test:8080', fetchImpl: hanging, timeoutMs: 20 })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('timed out')
  })
})

describe('checkApiKeyPresent', () => {
  it('passes and masks the key when present', () => {
    const r = checkApiKeyPresent(KEY)
    expect(r.status).toBe('pass')
    expect(r.message).not.toContain(KEY)
    expect(r.message).toContain('...')
  })
  it('fails with a login fix when absent', () => {
    const r = checkApiKeyPresent(undefined)
    expect(r.status).toBe('fail')
    expect(r.fix).toBe('run orca auth login')
  })
})

describe('checkKeyRole', () => {
  const base = { apiUrl: 'http://test:8080', apiKey: KEY, timeoutMs: 3000 }

  it('passes and reports role + label on a 200 with a matching keyId', async () => {
    const r = await checkKeyRole({
      ...base,
      keyId: 'key_9',
      fetchImpl: router({
        '/api/api-keys': () => jsonRes({ keys: [{ id: 'key_9', role: 'admin', name: 'cli-ada@laptop' }] }),
      }),
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('role admin')
    expect(r.message).toContain('cli-ada@laptop')
  })

  it('passes generically when no keyId is stored', async () => {
    const r = await checkKeyRole({
      ...base,
      fetchImpl: router({ '/api/api-keys': () => jsonRes({ keys: [] }) }),
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('member')
  })

  it('fails on 401 (invalid/revoked)', async () => {
    const r = await checkKeyRole({
      ...base,
      fetchImpl: router({ '/api/api-keys': () => jsonRes({ error: 'bad' }, 401) }),
    })
    expect(r.status).toBe('fail')
    expect(r.fix).toBe('run orca auth login')
  })

  it('warns on 403 (role below member)', async () => {
    const r = await checkKeyRole({
      ...base,
      fetchImpl: router({ '/api/api-keys': () => jsonRes({ error: 'forbidden' }, 403) }),
    })
    expect(r.status).toBe('warn')
    expect(r.message).toContain('below member')
  })

  it('warns (not fails) on a probe timeout', async () => {
    const r = await checkKeyRole({ ...base, fetchImpl: hanging, timeoutMs: 20 })
    expect(r.status).toBe('warn')
  })

  it('skips when no API key is configured', async () => {
    const r = await checkKeyRole({ apiUrl: base.apiUrl, fetchImpl: networkError, timeoutMs: 3000 })
    expect(r.status).toBe('skip')
  })
})

describe('checkBilling (402-risk mappings)', () => {
  const base = { apiUrl: 'http://test:8080', apiKey: KEY, timeoutMs: 3000 }

  it('passes when the wallet has credits', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ configured: true, balanceUSD: 12.5 }),
        '/api/spend-cap': () => jsonRes({ enabled: false }),
      }),
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('credits available')
  })

  it('passes (gate inactive) when billing is not wired (503)', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ error: 'billing not configured' }, 503),
        '/api/spend-cap': () => jsonRes({ enabled: false }),
      }),
    })
    expect(r.status).toBe('pass')
    expect(r.message).toContain('not wired')
  })

  it('fails when the wallet is unconfigured (no credits granted)', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ configured: false, balanceUSD: 0 }),
        '/api/spend-cap': () => jsonRes({ enabled: false }),
      }),
    })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('unconfigured')
    expect(r.fix).toContain('add credits')
  })

  it('fails when credits are exhausted (balance <= 0)', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ configured: true, balanceUSD: 0 }),
        '/api/spend-cap': () => jsonRes({ enabled: false }),
      }),
    })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('out of credits')
    expect(r.fix).toContain('top up')
  })

  it('fails when the billing path is broken (5xx), predicting the fail-closed 402', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ error: 'could not read wallet' }, 502),
        '/api/spend-cap': () => jsonRes({ enabled: false }),
      }),
    })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('fail-closed credit check')
    expect(r.fix).toContain('BILLING_INTERNAL_URL')
  })

  it('skips when the billing endpoints are absent (404, older conductor)', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ error: 'not found' }, 404),
        '/api/spend-cap': () => jsonRes({ error: 'not found' }, 404),
      }),
    })
    expect(r.status).toBe('skip')
  })

  it('fails on a reached monthly spend cap even when credits are fine', async () => {
    const r = await checkBilling({
      ...base,
      fetchImpl: router({
        '/api/billing/wallet': () => jsonRes({ configured: true, balanceUSD: 100 }),
        '/api/spend-cap': () =>
          jsonRes({
            enabled: true,
            month: { remaining_usd_cents: 0, spent_usd_cents: 5000, limit_usd_cents: 5000 },
          }),
      }),
    })
    expect(r.status).toBe('fail')
    expect(r.message).toContain('spend cap reached')
    expect(r.fix).toContain('orca billing cap set')
  })

  it('warns when the conductor cannot be reached to check billing', async () => {
    const r = await checkBilling({ ...base, fetchImpl: networkError })
    expect(r.status).toBe('warn')
  })

  it('skips without an API key', async () => {
    const r = await checkBilling({ apiUrl: base.apiUrl, fetchImpl: networkError, timeoutMs: 3000 })
    expect(r.status).toBe('skip')
  })
})

describe('checkGateway', () => {
  it('warns (with a fix) when the gateway URL is unresolved', async () => {
    const r = await checkGateway({ fetchImpl: networkError, timeoutMs: 3000 })
    expect(r.status).toBe('warn')
    expect(r.fix).toContain('ORCA_GATEWAY_URL')
  })

  it('passes when the gateway answers (any HTTP response is reachable)', async () => {
    const r = await checkGateway({
      gatewayUrl: 'https://gw.example.com',
      fetchImpl: router({ '/healthz': () => textRes('not found', 404) }),
      timeoutMs: 3000,
    })
    expect(r.status).toBe('pass')
  })

  it('warns when a set gateway cannot be reached', async () => {
    const r = await checkGateway({
      gatewayUrl: 'https://gw.example.com',
      fetchImpl: networkError,
      timeoutMs: 3000,
    })
    expect(r.status).toBe('warn')
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

  it('runs all 11 checks in display order against injected inputs', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY, keyId: 'key_9' } },
    })
    const ctx = await gatherContext({}, process.env)
    const fetchImpl = router({
      '/healthz': () => textRes('ok'),
      '/api/api-keys': () => jsonRes({ keys: [{ id: 'key_9', role: 'admin', name: 'cli' }] }),
      '/api/billing/wallet': () => jsonRes({ configured: true, balanceUSD: 5 }),
      '/api/spend-cap': () => jsonRes({ enabled: false }),
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
      'conductor',
      'api key',
      'api key role',
      'billing',
      'chat gateway',
      'dashboard url',
    ])
    expect(doctorExitCode(results)).toBe(0)
  })
})
