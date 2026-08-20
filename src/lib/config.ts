import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_API_URL,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_GATEWAY_URL,
  LEGACY_DEFAULT_API_URL,
} from './defaults.js'
import { CliError, ExitCode } from './errors.js'

export type ContextConfig = {
  apiUrl?: string
  gatewayUrl?: string
  apiKey?: string
  // Orca dashboard base URL used by the browser login flow (orca auth login).
  dashboardUrl?: string
  // Server-side id of the minted key, so `orca auth logout --revoke` can
  // DELETE /api/api-keys/{keyId}. Absent when the key was pasted manually.
  keyId?: string
}

export type CliConfig = {
  currentContext?: string
  contexts: Record<string, ContextConfig>
}

export type GlobalFlags = {
  context?: string
  apiUrl?: string
  json?: boolean
}

// Fields that can be filled from a baked-in production default.
export type DefaultableField = 'apiUrl' | 'gatewayUrl' | 'dashboardUrl'

// Everything a command needs to talk to the platform. apiKey stays optional
// here; ApiClient enforces its presence so `auth login` can run without one.
export type ResolvedContext = {
  name: string
  apiUrl?: string
  gatewayUrl?: string
  apiKey?: string
  dashboardUrl?: string
  keyId?: string
  // Fields whose value came from the baked-in production default (not a flag,
  // env var, or config file), so commands can mark them "(default)".
  defaulted: Set<DefaultableField>
  configPath: string
}

export const DEFAULT_CONTEXT = 'default'

export function configDir(): string {
  if (process.env.ORCA_CONFIG_DIR) return process.env.ORCA_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'orca')
}

export function configPath(): string {
  return path.join(configDir(), 'config.json')
}

export async function loadConfig(): Promise<CliConfig> {
  const file = configPath()
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { contexts: {} }
    }
    throw err
  }

  await warnIfPermissive(file)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliError(`config file is not valid JSON: ${file}`, ExitCode.Failure, [
      'Fix or remove the file, then run: orca auth login',
    ])
  }
  const cfg = parsed as CliConfig
  if (typeof cfg !== 'object' || cfg === null || typeof (cfg as CliConfig).contexts !== 'object') {
    throw new CliError(`config file has an unexpected shape: ${file}`, ExitCode.Failure, [
      'Expected { "currentContext": string, "contexts": { ... } }',
    ])
  }
  if (!cfg.contexts) cfg.contexts = {}
  return cfg
}

// The API key lives in this file; keep it private to the user. writeFile's
// mode only applies on creation, so re-chmod every save.
export async function saveConfig(cfg: CliConfig): Promise<string> {
  const dir = configDir()
  const file = configPath()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  await fs.chmod(file, 0o600)
  return file
}

async function warnIfPermissive(file: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const st = await fs.stat(file)
    if ((st.mode & 0o077) !== 0) {
      console.error(`warning: ${file} is readable by other users; run: chmod 600 ${file}`)
    }
  } catch {
    // stat raced with deletion; nothing to warn about.
  }
}

// Precedence per field: flag > env > config file.
export async function resolveContext(flags: GlobalFlags): Promise<ResolvedContext> {
  const cfg = await loadConfig()

  const explicitName = flags.context || process.env.ORCA_CONTEXT
  const name = explicitName || cfg.currentContext || DEFAULT_CONTEXT
  if (explicitName && !cfg.contexts[explicitName] && !hasEnvOverrides()) {
    throw new CliError(`context "${explicitName}" not found in ${configPath()}`, ExitCode.Usage, [
      'List contexts with: orca context list',
    ])
  }
  const base = cfg.contexts[name] ?? {}

  // Per field: flag > env > config file > baked-in default. Track which
  // fields fell through to the default so callers can label them.
  const defaulted = new Set<DefaultableField>()
  const upgradeLegacyApiUrl = (url: string | undefined): string | undefined =>
    url === LEGACY_DEFAULT_API_URL && DEFAULT_API_URL ? DEFAULT_API_URL : url
  const withDefault = (
    field: DefaultableField,
    explicit: string | undefined,
    fallback: string | null,
  ): string | undefined => {
    if (explicit) return explicit
    if (fallback) {
      defaulted.add(field)
      return fallback
    }
    return undefined
  }

  return {
    name,
    // The legacy upgrade rewrites only the exact former baked-in default (a
    // raw Railway hostname saved by cli<=0.4.0 logins); custom URLs pass
    // through untouched. `orca login` persists the upgraded value.
    apiUrl: withDefault(
      'apiUrl',
      upgradeLegacyApiUrl(flags.apiUrl || process.env.ORCA_API_URL || base.apiUrl),
      DEFAULT_API_URL,
    ),
    gatewayUrl: withDefault('gatewayUrl', process.env.ORCA_GATEWAY_URL || base.gatewayUrl, DEFAULT_GATEWAY_URL),
    apiKey: process.env.ORCA_API_KEY || base.apiKey,
    dashboardUrl: withDefault('dashboardUrl', process.env.ORCA_DASHBOARD_URL || base.dashboardUrl, DEFAULT_DASHBOARD_URL),
    keyId: base.keyId,
    defaulted,
    configPath: configPath(),
  }
}

function hasEnvOverrides(): boolean {
  return Boolean(process.env.ORCA_API_KEY && process.env.ORCA_API_URL)
}

export function requireApiUrl(ctx: ResolvedContext): string {
  if (!ctx.apiUrl) {
    throw new CliError(`no API URL configured for context "${ctx.name}"`, ExitCode.Usage, [
      'Run: orca auth login --api-url <url>',
      'Or set ORCA_API_URL.',
    ])
  }
  return ctx.apiUrl.replace(/\/+$/, '')
}

export function requireApiKey(ctx: ResolvedContext): string {
  if (!ctx.apiKey) {
    throw new CliError(`no API key configured for context "${ctx.name}"`, ExitCode.Auth, [
      'Run: orca auth login',
      'Or set ORCA_API_KEY.',
    ])
  }
  return ctx.apiKey
}

// maskKey renders a stored key for display: prefix plus last four characters.
export function maskKey(key: string): string {
  if (key.length <= 12) return '****'
  const parts = key.split('_')
  const prefix = parts.length >= 3 ? `${parts[0]}_${parts[1]}_` : key.slice(0, 3)
  return `${prefix}...${key.slice(-4)}`
}
