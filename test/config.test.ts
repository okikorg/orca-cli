import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  configPath,
  loadConfig,
  maskKey,
  resolveContext,
  saveConfig,
} from '../src/lib/config.js'
import { CliError, ExitCode } from '../src/lib/errors.js'
import { useTmpConfigDir } from './helpers/tmp-config.js'

let cleanup: () => Promise<void>
let dir: string

const ENV_KEYS = [
  'ORCA_API_KEY',
  'ORCA_API_URL',
  'ORCA_GATEWAY_URL',
  'ORCA_DASHBOARD_URL',
  'ORCA_CONTEXT',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  dir = tmp.dir
  cleanup = tmp.cleanup
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(async () => {
  await cleanup()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('loadConfig', () => {
  it('returns an empty config when no file exists', async () => {
    expect(await loadConfig()).toEqual({ contexts: {} })
  })

  it('round-trips through saveConfig', async () => {
    await saveConfig({
      currentContext: 'local',
      contexts: { local: { apiUrl: 'http://localhost:8080', apiKey: 'ao_dev_x'.padEnd(30, 'y') } },
    })
    const cfg = await loadConfig()
    expect(cfg.currentContext).toBe('local')
    expect(cfg.contexts.local.apiUrl).toBe('http://localhost:8080')
  })

  it('rejects invalid JSON with a CliError', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'config.json'), 'not json', { mode: 0o600 })
    await expect(loadConfig()).rejects.toThrow(CliError)
  })
})

describe('saveConfig permissions', () => {
  it('writes the file with mode 0600', async () => {
    const file = await saveConfig({ contexts: {} })
    const st = await fs.stat(file)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('re-tightens permissions on an existing loose file', async () => {
    const file = await saveConfig({ contexts: {} })
    await fs.chmod(file, 0o644)
    await saveConfig({ contexts: {} })
    const st = await fs.stat(file)
    expect(st.mode & 0o777).toBe(0o600)
  })
})

describe('resolveContext precedence', () => {
  beforeEach(async () => {
    await saveConfig({
      currentContext: 'local',
      contexts: {
        local: { apiUrl: 'http://file:8080', gatewayUrl: 'http://file:8090', apiKey: 'ao_dev_filekey0000000000000000' },
        prod: { apiUrl: 'https://prod.example', apiKey: 'ao_live_prodkey0000000000000000' },
      },
    })
  })

  it('uses the current context from the file', async () => {
    const ctx = await resolveContext({})
    expect(ctx.name).toBe('local')
    expect(ctx.apiUrl).toBe('http://file:8080')
    expect(ctx.apiKey).toBe('ao_dev_filekey0000000000000000')
    expect(ctx.configPath).toBe(configPath())
  })

  it('env vars override file values per field', async () => {
    process.env.ORCA_API_URL = 'http://env:9090'
    const ctx = await resolveContext({})
    expect(ctx.apiUrl).toBe('http://env:9090')
    expect(ctx.apiKey).toBe('ao_dev_filekey0000000000000000')
  })

  it('flags override env and file', async () => {
    process.env.ORCA_API_URL = 'http://env:9090'
    const ctx = await resolveContext({ apiUrl: 'http://flag:7070' })
    expect(ctx.apiUrl).toBe('http://flag:7070')
  })

  it('selects a named context via flag', async () => {
    const ctx = await resolveContext({ context: 'prod' })
    expect(ctx.apiUrl).toBe('https://prod.example')
  })

  it('selects a named context via ORCA_CONTEXT', async () => {
    process.env.ORCA_CONTEXT = 'prod'
    const ctx = await resolveContext({})
    expect(ctx.name).toBe('prod')
  })

  it('errors on an explicitly named missing context', async () => {
    await expect(resolveContext({ context: 'nope' })).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('allows a missing context when env provides key and url', async () => {
    process.env.ORCA_API_KEY = 'ao_ci_envkey000000000000000000'
    process.env.ORCA_API_URL = 'http://ci:8080'
    const ctx = await resolveContext({ context: 'ci-only' })
    expect(ctx.apiKey).toBe('ao_ci_envkey000000000000000000')
    expect(ctx.apiUrl).toBe('http://ci:8080')
  })
})

describe('maskKey', () => {
  it('shows the prefix and last four characters', () => {
    expect(maskKey('ao_dev_abcdefghijklmnopqrstuv')).toBe('ao_dev_...stuv')
  })

  it('fully masks short strings', () => {
    expect(maskKey('short')).toBe('****')
  })
})
