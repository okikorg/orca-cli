// Pure preflight checks behind `orca doctor`. Each check returns a
// {name, status, message, fix?} verdict and is individually testable; the
// network probes take an injected fetch so tests never touch the real host.
// No Ink imports here: rendering lives in commands/doctor.tsx + ui/DoctorReport.
//
// Grounded in how the CLI actually resolves config (lib/config.ts) and how the
// conductor answers (agent-runtime/runtime/httpapi): /healthz is unauthed and
// returns "ok"; GET /api/api-keys is RoleMember-gated (a 200 proves member+);
// the run-create credit gate 402s with credit_check_unavailable when billing is
// wired but unreachable, so we read GET /api/billing/wallet + /api/spend-cap to
// predict that WITHOUT creating a run.

import { promises as fs } from 'node:fs'

import {
  configPath,
  DEFAULT_CONTEXT,
  loadConfig,
  maskKey,
  type CliConfig,
  type ContextConfig,
  type DefaultableField,
} from './config.js'
import { DEFAULT_API_URL, DEFAULT_DASHBOARD_URL, DEFAULT_GATEWAY_URL } from './defaults.js'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export type CheckResult = {
  name: string
  status: CheckStatus
  message: string
  // A one-line, copy-pasteable remedy shown under a warn/fail.
  fix?: string
  // Informational warns (color/TTY) that must never become a failure, even
  // under --strict. Never serialized to JSON output.
  soft?: boolean
}

// A fetch-shaped function. The real global fetch satisfies this; tests pass a
// local mock so the suite never blanket-stubs global fetch (which would break
// Ink's yoga-wasm loader).
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

// Where a resolved config field's value came from, for the context check.
export type FieldSource = 'flag' | 'env' | 'file' | 'default' | 'unset'
type SourcedField = 'apiUrl' | 'gatewayUrl' | 'dashboardUrl' | 'apiKey'

// Per-probe budget. A hung network call must never make doctor hang; 3s is long
// enough for a healthy cross-region round-trip and short enough to feel snappy.
export const PROBE_TIMEOUT_MS = 3000

// -- Context gathering --------------------------------------------------------

// DoctorContext is the fully resolved view doctor works from. It mirrors
// lib/config.ts precedence (flag > env > file > baked-in default) but, unlike
// resolveContext, it tolerates a corrupt config file (records parseError and
// falls back to env + defaults) and exposes the per-field source so the context
// check can show where each value came from.
export type DoctorContext = {
  name: string
  apiUrl?: string
  gatewayUrl?: string
  dashboardUrl?: string
  apiKey?: string
  keyId?: string
  defaulted: Set<DefaultableField>
  configPath: string
  configPresent: boolean
  parseError?: string
  sources: Record<SourcedField, FieldSource>
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// computeFieldSources labels each resolvable field by its winning source. Only
// the URL fields have a baked-in default; the key never does (a default key
// would be a security hole), and gateway/dashboard have no flag.
export function computeFieldSources(a: {
  defaulted: Set<DefaultableField>
  flags: { apiUrl?: string }
  env: NodeJS.ProcessEnv
  file: ContextConfig
}): Record<SourcedField, FieldSource> {
  const { defaulted, flags, env, file } = a
  const apiUrl: FieldSource = defaulted.has('apiUrl')
    ? 'default'
    : flags.apiUrl
      ? 'flag'
      : env.ORCA_API_URL
        ? 'env'
        : file.apiUrl
          ? 'file'
          : 'unset'
  const gatewayUrl: FieldSource = defaulted.has('gatewayUrl')
    ? 'default'
    : env.ORCA_GATEWAY_URL
      ? 'env'
      : file.gatewayUrl
        ? 'file'
        : 'unset'
  const dashboardUrl: FieldSource = defaulted.has('dashboardUrl')
    ? 'default'
    : env.ORCA_DASHBOARD_URL
      ? 'env'
      : file.dashboardUrl
        ? 'file'
        : 'unset'
  const apiKey: FieldSource = env.ORCA_API_KEY ? 'env' : file.apiKey ? 'file' : 'unset'
  return { apiUrl, gatewayUrl, dashboardUrl, apiKey }
}

// gatherContext resolves the effective context for doctor. It never throws on a
// bad config file: a parse/shape error is captured in parseError and resolution
// continues from env + baked-in defaults so the rest of the report still runs.
export async function gatherContext(
  flags: { context?: string; apiUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorContext> {
  const path = configPath()
  const present = await fileExists(path)

  let cfg: CliConfig = { contexts: {} }
  let parseError: string | undefined
  try {
    cfg = await loadConfig()
  } catch (err) {
    // Corrupt or unexpected shape: keep going from env + defaults.
    parseError = err instanceof Error ? err.message : String(err)
  }

  const name = flags.context || env.ORCA_CONTEXT || cfg.currentContext || DEFAULT_CONTEXT
  const file = cfg.contexts[name] ?? {}

  const defaulted = new Set<DefaultableField>()
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

  const apiUrl = withDefault(
    'apiUrl',
    flags.apiUrl || env.ORCA_API_URL || file.apiUrl,
    DEFAULT_API_URL,
  )
  const gatewayUrl = withDefault(
    'gatewayUrl',
    env.ORCA_GATEWAY_URL || file.gatewayUrl,
    DEFAULT_GATEWAY_URL,
  )
  const dashboardUrl = withDefault(
    'dashboardUrl',
    env.ORCA_DASHBOARD_URL || file.dashboardUrl,
    DEFAULT_DASHBOARD_URL,
  )

  return {
    name,
    apiUrl: trimUrl(apiUrl),
    gatewayUrl: trimUrl(gatewayUrl),
    dashboardUrl: trimUrl(dashboardUrl),
    apiKey: env.ORCA_API_KEY || file.apiKey,
    keyId: file.keyId,
    defaulted,
    configPath: path,
    configPresent: present,
    parseError,
    sources: computeFieldSources({ defaulted, flags, env, file }),
  }
}

function trimUrl(u: string | undefined): string | undefined {
  return u ? u.replace(/\/+$/, '') : u
}

// -- Network probe ------------------------------------------------------------

type FetchOutcome =
  | { kind: 'response'; res: Response; latencyMs: number }
  | { kind: 'timeout'; latencyMs: number }
  | { kind: 'network'; latencyMs: number; message: string }

// timedFetch races a request against a hard deadline. A timeout aborts the
// request (AbortSignal.timeout), so doctor can never hang on a dead host.
async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const started = performance.now()
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    return { kind: 'response', res, latencyMs: Math.round(performance.now() - started) }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started)
    const nm = err instanceof Error ? err.name : ''
    if (nm === 'TimeoutError' || nm === 'AbortError') return { kind: 'timeout', latencyMs }
    return { kind: 'network', latencyMs, message: err instanceof Error ? err.message : String(err) }
  }
}

function authInit(apiKey: string): RequestInit {
  return { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

function isLocalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === '::1' ||
      h.endsWith('.local')
    )
  } catch {
    return false
  }
}

// -- Environment checks -------------------------------------------------------

// 1. Node >= 22 (package.json engines).
export function checkNode(version: string): CheckResult {
  const name = 'node version'
  const major = Number(version.split('.')[0])
  if (Number.isFinite(major) && major >= 22) {
    return { name, status: 'pass', message: `Node ${version} (>= 22)` }
  }
  return {
    name,
    status: 'fail',
    message: `Node ${version} is older than the required v22`,
    fix: 'install Node 22 or newer (nodejs.org, or nvm install 22)',
  }
}

// 2. Color/TTY situation. Purely informational: disabled color is never a
//    failure, so these warns are soft (exempt from --strict promotion).
export function checkColor(o: { noColor: boolean; isTTY: boolean }): CheckResult {
  const name = 'color output'
  if (!o.isTTY) {
    return {
      name,
      status: 'warn',
      message: 'stdout is not a TTY; themed output is disabled (plain text)',
      soft: true,
    }
  }
  if (o.noColor) {
    return { name, status: 'warn', message: 'NO_COLOR is set; color is disabled', soft: true }
  }
  return { name, status: 'pass', message: 'themed color output enabled' }
}

// -- Config checks ------------------------------------------------------------

// 3. Config file exists and parses. A missing file is at most a warn (env and
//    baked-in defaults cover apiUrl); only a present-but-corrupt file fails.
export function checkConfigFile(o: {
  present: boolean
  parseError?: string
  path: string
  envKey: boolean
}): CheckResult {
  const name = 'config file'
  if (o.present && o.parseError) {
    return {
      name,
      status: 'fail',
      message: `config file is corrupt: ${o.parseError}`,
      fix: `fix or remove ${o.path}, then run orca auth login`,
    }
  }
  if (o.present) return { name, status: 'pass', message: `parsed OK (${o.path})` }
  if (o.envKey) {
    return { name, status: 'pass', message: 'no config file; using environment (ORCA_API_KEY/ORCA_API_URL)' }
  }
  return {
    name,
    status: 'warn',
    message: `no config file at ${o.path}`,
    fix: 'run orca auth login to store a key and context',
  }
}

// 4. Config file permissions. The config layer chmods 600 on every save; doctor
//    verifies the on-disk state and offers the exact remedy.
export async function checkConfigPermissions(path: string): Promise<CheckResult> {
  const name = 'config permissions'
  if (process.platform === 'win32') {
    return { name, status: 'skip', message: 'not enforced on Windows' }
  }
  let mode: number
  try {
    const st = await fs.stat(path)
    mode = st.mode & 0o777
  } catch {
    return { name, status: 'skip', message: 'no config file to check' }
  }
  const octal = mode.toString(8).padStart(3, '0')
  if ((mode & 0o077) !== 0) {
    return {
      name,
      status: 'fail',
      message: `${path} is readable by other users (mode ${octal})`,
      fix: `chmod 600 ${path}`,
    }
  }
  return { name, status: 'pass', message: `owner-only (mode ${octal})` }
}

// 5. Effective context resolution. Informational: shows the active context and
//    where each field's value came from (flag/env/file/default).
export function checkContext(o: {
  name: string
  sources: Record<SourcedField, FieldSource>
}): CheckResult {
  const s = o.sources
  const summary = `apiUrl=${s.apiUrl}, gateway=${s.gatewayUrl}, dashboard=${s.dashboardUrl}, key=${s.apiKey}`
  return { name: 'context', status: 'pass', message: `active "${o.name}"; ${summary}` }
}

// -- Connectivity + auth checks (read-only probes only) -----------------------

// 6. Conductor reachability: GET /healthz (unauthed, returns "ok"). A timeout or
//    unreachable host is a hard failure here (this is what every other command
//    needs), with a localhost-vs-remote fix hint.
export async function checkConductor(o: {
  apiUrl?: string
  fetchImpl: FetchLike
  timeoutMs: number
}): Promise<CheckResult> {
  const name = 'conductor'
  if (!o.apiUrl) {
    return {
      name,
      status: 'fail',
      message: 'no API URL configured',
      fix: 'run orca auth login --api-url <url>, or set ORCA_API_URL',
    }
  }
  const r = await timedFetch(o.fetchImpl, `${o.apiUrl}/healthz`, {}, o.timeoutMs)
  const fix = isLocalHost(o.apiUrl)
    ? 'is your local conductor running? or unset the local override (ORCA_API_URL) to use the Orca production API'
    : `check your connection and that ${o.apiUrl} is reachable (see the Orca status page)`
  if (r.kind === 'timeout') {
    return { name, status: 'fail', message: `timed out after ${o.timeoutMs}ms reaching ${o.apiUrl}/healthz`, fix }
  }
  if (r.kind === 'network') {
    return { name, status: 'fail', message: `cannot reach ${o.apiUrl} (${r.message})`, fix }
  }
  if (!r.res.ok) {
    return { name, status: 'fail', message: `HTTP ${r.res.status} from ${o.apiUrl}/healthz`, fix }
  }
  return { name, status: 'pass', message: `reachable in ${r.latencyMs}ms (HTTP ${r.res.status})` }
}

// 7. API key present.
export function checkApiKeyPresent(apiKey?: string): CheckResult {
  const name = 'api key'
  if (apiKey) return { name, status: 'pass', message: `configured (${maskKey(apiKey)})` }
  return { name, status: 'fail', message: 'no API key configured', fix: 'run orca auth login' }
}

// 8. Key validity + role: GET /api/api-keys (RoleMember-gated, read-only). A 200
//    proves the key is valid AND member+; when the stored context carries a
//    keyId we report the matching key's role and label.
export async function checkKeyRole(o: {
  apiUrl?: string
  apiKey?: string
  keyId?: string
  fetchImpl: FetchLike
  timeoutMs: number
}): Promise<CheckResult> {
  const name = 'api key role'
  if (!o.apiUrl) return { name, status: 'skip', message: 'no API URL' }
  if (!o.apiKey) return { name, status: 'skip', message: 'skipped (no API key)' }
  const r = await timedFetch(o.fetchImpl, `${o.apiUrl}/api/api-keys`, authInit(o.apiKey), o.timeoutMs)
  // A probe that cannot complete is a warn here (check 6 owns the hard fail).
  if (r.kind === 'timeout') return { name, status: 'warn', message: 'timed out validating the API key' }
  if (r.kind === 'network') {
    return { name, status: 'warn', message: 'could not reach the conductor to validate the key' }
  }
  const st = r.res.status
  if (st === 401) {
    return { name, status: 'fail', message: 'key invalid or revoked', fix: 'run orca auth login' }
  }
  if (st === 403) {
    return {
      name,
      status: 'warn',
      message: 'key role is below member; some commands will be blocked',
      fix: 'use a member+ key, or run orca auth login with a higher-role account',
    }
  }
  if (st === 404) {
    return { name, status: 'warn', message: 'api-keys endpoint not present; cannot confirm the key role' }
  }
  if (st >= 500) {
    return { name, status: 'warn', message: `conductor returned HTTP ${st} validating the key` }
  }
  if (st === 200) {
    const body = (await readJson(r.res)) as
      | { keys?: { id: string; role?: string; name?: string }[] }
      | undefined
    const keys = body?.keys ?? []
    const row = o.keyId ? keys.find((k) => k.id === o.keyId) : undefined
    if (row) {
      const label = row.name ? `, key "${row.name}"` : ''
      return { name, status: 'pass', message: `valid; role ${row.role ?? 'member'}${label}` }
    }
    return { name, status: 'pass', message: 'valid (member or higher)' }
  }
  return { name, status: 'warn', message: `unexpected HTTP ${st} validating the key` }
}

// -- Billing / credit preflight ----------------------------------------------

type WalletBody = { configured?: boolean; balanceUSD?: number }
type CapPeriod = { remaining_usd_cents?: number; spent_usd_cents?: number; limit_usd_cents?: number }
type CapBody = { enabled?: boolean; month?: CapPeriod }

function cents(n: number | undefined): string {
  return ((n ?? 0) / 100).toFixed(2)
}

// classifyWallet maps GET /api/billing/wallet onto the run-create credit gate's
// behaviour:
//   503 "billing not configured" -> s.billing == nil -> gate is a pass-through
//       (runs are NOT blocked on credits). Healthy for running agents.
//   200 configured:false         -> wallet unconfigured; gate is wired and
//       fail-closed, so Authorize denies -> credits_exhausted 402. Blocked.
//   200 balanceUSD <= 0          -> out of credits -> credits_exhausted. Blocked.
//   200 balanceUSD > 0           -> healthy.
//   5xx (e.g. 502)               -> billing wired but its path is broken; the
//       credit gate would fail-closed -> credit_check_unavailable 402. Blocked.
//   404                          -> older conductor without the route -> skip.
async function classifyWallet(r: FetchOutcome): Promise<CheckResult> {
  const name = 'billing'
  if (r.kind === 'timeout') return { name, status: 'warn', message: 'timed out checking billing' }
  if (r.kind === 'network') {
    return { name, status: 'warn', message: 'could not reach the conductor to check billing' }
  }
  const st = r.res.status
  if (st === 503) {
    return {
      name,
      status: 'pass',
      message: 'billing not wired; credit gate inactive (runs will not be blocked on credits)',
    }
  }
  if (st === 404) {
    return { name, status: 'skip', message: 'billing endpoints not present on this conductor; skipping' }
  }
  if (st === 401) {
    return { name, status: 'warn', message: 'could not check billing (key rejected)', fix: 'run orca auth login' }
  }
  if (st === 403) {
    return { name, status: 'warn', message: 'could not check billing (insufficient role)' }
  }
  if (st >= 500) {
    return {
      name,
      status: 'fail',
      message: `billing service unreachable (HTTP ${st}); runs will be blocked (fail-closed credit check)`,
      fix: 'if this is a local conductor, unset BILLING_INTERNAL_URL or run the billing service; otherwise top up / retry shortly',
    }
  }
  if (st === 200) {
    const body = (await readJson(r.res)) as WalletBody | undefined
    if (!body) return { name, status: 'warn', message: 'billing wallet returned an unreadable body' }
    if (!body.configured) {
      return {
        name,
        status: 'fail',
        message: 'no credits on this tenant (wallet unconfigured); runs will be blocked',
        fix: 'add credits in the dashboard',
      }
    }
    const bal = typeof body.balanceUSD === 'number' ? body.balanceUSD : 0
    if (bal <= 0) {
      return {
        name,
        status: 'fail',
        message: `out of credits (balance $${bal.toFixed(2)}); runs will be blocked`,
        fix: 'top up credits in the dashboard',
      }
    }
    return { name, status: 'pass', message: `credits available (balance $${bal.toFixed(2)})` }
  }
  return { name, status: 'warn', message: `billing check got HTTP ${st}` }
}

// classifyCapReached returns a fail only when the monthly spend cap is enforced
// and already exhausted (the spend-cap breaker 402s new runs fail-closed).
// Everything else (disabled, unavailable, older conductor) returns null so it
// never overrides the wallet verdict.
async function classifyCapReached(r: FetchOutcome): Promise<CheckResult | null> {
  if (r.kind !== 'response' || r.res.status !== 200) return null
  const body = (await readJson(r.res)) as CapBody | undefined
  if (!body || !body.enabled || !body.month) return null
  const m = body.month
  if (
    typeof m.remaining_usd_cents === 'number' &&
    m.remaining_usd_cents <= 0 &&
    (m.spent_usd_cents ?? 0) > 0
  ) {
    return {
      name: 'billing',
      status: 'fail',
      message: `monthly spend cap reached (spent $${cents(m.spent_usd_cents)} of $${cents(m.limit_usd_cents)}); runs will be blocked`,
      fix: 'raise the cap with: orca billing cap set <amount>, or wait for the monthly reset',
    }
  }
  return null
}

// 9. Billing/credit preflight. Reads wallet + spend-cap (both read-only) to
//    predict the POST /api/runs 402 without creating a run. A hard credit fail
//    (unconfigured / exhausted / billing unreachable) dominates; otherwise a
//    reached spend cap is surfaced; otherwise the wallet verdict stands.
export async function checkBilling(o: {
  apiUrl?: string
  apiKey?: string
  fetchImpl: FetchLike
  timeoutMs: number
}): Promise<CheckResult> {
  const name = 'billing'
  if (!o.apiUrl) return { name, status: 'skip', message: 'no API URL' }
  if (!o.apiKey) return { name, status: 'skip', message: 'skipped (no API key)' }
  const [walletR, capR] = await Promise.all([
    timedFetch(o.fetchImpl, `${o.apiUrl}/api/billing/wallet`, authInit(o.apiKey), o.timeoutMs),
    timedFetch(o.fetchImpl, `${o.apiUrl}/api/spend-cap`, authInit(o.apiKey), o.timeoutMs),
  ])
  const wallet = await classifyWallet(walletR)
  const capFail = await classifyCapReached(capR)
  if (wallet.status === 'fail') return wallet
  if (capFail) return capFail
  return wallet
}

// -- Gateway + dashboard checks ----------------------------------------------

// 10. Gateway config for `orca chat`. An unresolved gateway URL is a warn (chat
//     is the only command that needs it). When set, any HTTP response to
//     /healthz proves reachability.
export async function checkGateway(o: {
  gatewayUrl?: string
  fetchImpl: FetchLike
  timeoutMs: number
}): Promise<CheckResult> {
  const name = 'chat gateway'
  if (!o.gatewayUrl) {
    return {
      name,
      status: 'warn',
      message: 'no chat gateway URL (needed only for orca chat)',
      fix: 'set ORCA_GATEWAY_URL or --gateway-url; needed only for orca chat',
    }
  }
  const r = await timedFetch(o.fetchImpl, `${o.gatewayUrl}/healthz`, {}, o.timeoutMs)
  if (r.kind === 'timeout') {
    return {
      name,
      status: 'warn',
      message: `gateway did not respond within ${o.timeoutMs}ms (${o.gatewayUrl})`,
      fix: 'verify ORCA_GATEWAY_URL points at a running chat gateway',
    }
  }
  if (r.kind === 'network') {
    return {
      name,
      status: 'warn',
      message: `gateway not reachable (${o.gatewayUrl})`,
      fix: 'verify ORCA_GATEWAY_URL points at a running chat gateway',
    }
  }
  // Any response (even 404) means the host answered, so it is reachable.
  return { name, status: 'pass', message: `reachable in ${r.latencyMs}ms (HTTP ${r.res.status})` }
}

// 11. Dashboard URL resolution (the browser login flow needs it). Notes when the
//     value is the baked-in default.
export function checkDashboard(o: { dashboardUrl?: string; defaulted: boolean }): CheckResult {
  const name = 'dashboard url'
  if (!o.dashboardUrl) {
    return {
      name,
      status: 'warn',
      message: 'no dashboard URL (needed for the orca auth login browser flow)',
      fix: 'set ORCA_DASHBOARD_URL or pass --dashboard-url',
    }
  }
  return { name, status: 'pass', message: `${o.dashboardUrl}${o.defaulted ? ' (default)' : ''}` }
}

// -- Orchestration ------------------------------------------------------------

export type RunDoctorOptions = {
  ctx: DoctorContext
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
  nodeVersion?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

// runDoctor executes every check and returns results in display order. The four
// network probes run concurrently so a slow host does not serialize the wait.
export async function runDoctor(o: RunDoctorOptions): Promise<CheckResult[]> {
  const env = o.env ?? process.env
  const isTTY = o.isTTY ?? Boolean(process.stdout.isTTY)
  const nodeVersion = o.nodeVersion ?? process.versions.node
  const fetchImpl = o.fetchImpl ?? (globalThis.fetch as FetchLike)
  const timeoutMs = o.timeoutMs ?? PROBE_TIMEOUT_MS
  const ctx = o.ctx

  const node = checkNode(nodeVersion)
  const color = checkColor({ noColor: Boolean(env.NO_COLOR), isTTY })
  const configFile = checkConfigFile({
    present: ctx.configPresent,
    parseError: ctx.parseError,
    path: ctx.configPath,
    envKey: Boolean(env.ORCA_API_KEY),
  })
  const perms = await checkConfigPermissions(ctx.configPath)
  const context = checkContext({ name: ctx.name, sources: ctx.sources })
  const apiKey = checkApiKeyPresent(ctx.apiKey)
  const dashboard = checkDashboard({
    dashboardUrl: ctx.dashboardUrl,
    defaulted: ctx.defaulted.has('dashboardUrl'),
  })

  const [conductor, keyRole, billing, gateway] = await Promise.all([
    checkConductor({ apiUrl: ctx.apiUrl, fetchImpl, timeoutMs }),
    checkKeyRole({ apiUrl: ctx.apiUrl, apiKey: ctx.apiKey, keyId: ctx.keyId, fetchImpl, timeoutMs }),
    checkBilling({ apiUrl: ctx.apiUrl, apiKey: ctx.apiKey, fetchImpl, timeoutMs }),
    checkGateway({ gatewayUrl: ctx.gatewayUrl, fetchImpl, timeoutMs }),
  ])

  return [node, color, configFile, perms, context, conductor, apiKey, keyRole, billing, gateway, dashboard]
}

// applyStrict promotes warns to failures under --strict, except soft
// (informational) warns like the color/TTY notice, which are never failures.
export function applyStrict(results: CheckResult[], strict: boolean): CheckResult[] {
  if (!strict) return results
  return results.map((r) =>
    r.status === 'warn' && !r.soft ? { ...r, status: 'fail' as const } : r,
  )
}

// doctorExitCode: 1 when any check failed, else 0 (warns are allowed).
export function doctorExitCode(results: CheckResult[]): number {
  return results.some((r) => r.status === 'fail') ? 1 : 0
}

export function summarize(results: CheckResult[]): {
  pass: number
  warn: number
  fail: number
  skip: number
} {
  const s = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const r of results) s[r.status] += 1
  return s
}

// toJsonResults strips the internal `soft` flag, leaving the documented
// {name, status, message, fix?} shape for --json.
export function toJsonResults(
  results: CheckResult[],
): { name: string; status: CheckStatus; message: string; fix?: string }[] {
  return results.map((r) =>
    r.fix
      ? { name: r.name, status: r.status, message: r.message, fix: r.fix }
      : { name: r.name, status: r.status, message: r.message },
  )
}
