// Clients for the Orca server. Two surfaces, one bearer key:
//
// - /api: the server's own routes (whoami, keys, usage, billing, kits),
//   through the thin fetch helper below.
// - /v1: the OpenAI-compatible Agents API (agents, sessions, skills, vaults,
//   files), through the official `openai` package, exactly as any OpenAI
//   client calls it. v1() builds that client lazily so commands that never
//   touch /v1 do not load the package.
//
// The server derives the tenant from the key, so no tenant header is sent.

import type OpenAI from 'openai'
import { APIConnectionTimeoutError, APIError as OpenAIAPIError, APIConnectionError } from 'openai/error'

import { CliError, ExitCode } from './errors.js'
import type {
  APIKey,
  APIKeyIssued,
  BillingURL,
  Kit,
  KitCopyAsset,
  KitCopyResult,
  KitInput,
  ListPage,
  PublicKit,
  UsageEvent,
  UsageSummary,
  Wallet,
  Whoami,
} from './types.js'

// ApiError is a refused /api request. Callers decide on `code`, the
// server's machine-readable reason, never on the HTTP status alone.
export class ApiError extends Error {
  status: number
  body?: unknown
  code: string | null
  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
    this.code = errorCode(body)
  }
}

// errorCode is the server's machine-readable reason: `error.code` in
// {"error": {"message", "type", "param", "code"}}, or the device login
// routes' {"error": "<code>"}.
export function errorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as Record<string, unknown>).error
  if (typeof error === 'string') return error || null
  if (!error || typeof error !== 'object') return null
  const code = (error as Record<string, unknown>).code
  return typeof code === 'string' && code ? code : null
}

// Page is the CLI's view of one cursor page: the rows, whether the server has
// more after them, and the cursor (the last row's id) that fetches the next.
export type Page<T> = { items: T[]; hasMore: boolean; lastId: string | null }

// PageParams are the cursor knobs every list route accepts. The server takes
// 1 to 100 rows per request and lists newest first.
export type PageParams = { limit?: number; after?: string }

// pageQuery renders query parameters into a query string. Only defined,
// non-empty values are emitted, so a call with no params yields ''.
export function pageQuery(params?: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') sp.set(key, String(value))
    }
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

// toPage adapts a list envelope (the /api routes' JSON, or an openai page
// object, which carries the same data and has_more fields) to a Page.
export function toPage<T extends { id: string }>(list: { data: T[]; has_more: boolean }): Page<T> {
  const items = list.data ?? []
  return { items, hasMore: Boolean(list.has_more), lastId: items.at(-1)?.id ?? null }
}

export type ApiClientOptions = {
  apiUrl: string
  apiKey: string
  contextName: string
  // The dashboard this context logged in from, sent as Origin where the
  // server returns the user to the dashboard (checkout, portal).
  dashboardUrl?: string
  // JSON request timeout in milliseconds. Streaming requests manage their own.
  timeoutMs?: number
}

// extractErrorBody pulls a human-readable reason out of an error body. The
// server answers {"error": {"message", "type", "param", "code"}}; the device
// login routes answer {"error": "<code>"}.
export function extractErrorBody(body: unknown): string {
  if (!body) return ''
  if (typeof body === 'string') return body
  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>
    if (typeof rec.error === 'string') return rec.error
    if (rec.error && typeof rec.error === 'object') {
      const message = (rec.error as Record<string, unknown>).message
      if (typeof message === 'string') return message
    }
    if (typeof rec.message === 'string') return rec.message
  }
  return ''
}

// errorParam is the field a refusal is about: the server's `param`.
function errorParam(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as Record<string, unknown>).error
  if (!error || typeof error !== 'object') return null
  const param = (error as Record<string, unknown>).param
  return typeof param === 'string' && param ? param : null
}

// mapApiError converts a failure from either client into the CliError the
// top-level trap renders, distinguishing auth, not-found, server, and
// connectivity failures so the user knows which one to fix.
export function mapApiError(err: unknown, opts: { contextName: string; apiUrl: string }): CliError {
  if (err instanceof CliError) return err
  // openai raises APIConnectionError (a subclass of its APIError, with no
  // status) when it cannot reach the host, so check it first.
  if (err instanceof APIConnectionTimeoutError) {
    return new CliError(`request to ${opts.apiUrl} timed out`, ExitCode.Failure)
  }
  if (err instanceof APIConnectionError || err instanceof TypeError) {
    return new CliError(`cannot reach ${opts.apiUrl} (context "${opts.contextName}")`, ExitCode.Failure, [
      'Is the server running? Check: orca auth status',
    ])
  }
  let status: number | undefined
  let reason = ''
  let param: string | null = null
  if (err instanceof ApiError) {
    status = err.status
    reason = extractErrorBody(err.body)
    param = errorParam(err.body)
  } else if (err instanceof OpenAIAPIError && err.status !== undefined) {
    status = err.status
    reason = extractErrorBody({ error: err.error })
    param = errorParam({ error: err.error })
  }
  if (reason && param) reason = `${reason} (${param})`
  if (status !== undefined) {
    if (status === 401) {
      return new CliError(
        `invalid or revoked API key for context "${opts.contextName}"`,
        ExitCode.Auth,
        ['Run: orca auth login'],
      )
    }
    if (status === 403) {
      return new CliError(
        reason
          ? `not allowed: ${reason} (context "${opts.contextName}")`
          : `your API key's role does not allow this action (context "${opts.contextName}")`,
        ExitCode.Auth,
      )
    }
    if (status === 404) {
      return new CliError(reason ? `not found: ${reason}` : 'not found', ExitCode.NotFound)
    }
    if (status === 410) {
      return new CliError(reason || 'gone', ExitCode.NotFound)
    }
    if (status >= 500) {
      return new CliError(
        reason ? `the API server returned ${status}: ${reason}; try again in a moment` : `the API server returned ${status}; try again in a moment`,
        ExitCode.Failure,
      )
    }
    return new CliError(reason ? `${status}: ${reason}` : `request failed (${status})`, ExitCode.Failure)
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new CliError(`request to ${opts.apiUrl} timed out`, ExitCode.Failure)
  }
  return err instanceof Error
    ? new CliError(err.message, ExitCode.Failure)
    : new CliError('unknown error', ExitCode.Failure)
}

// The server returns at most 100 rows per request; --all pages through in
// windows of this size, up to a hard safety ceiling.
export const FETCH_ALL_PAGE_SIZE = 100
export const FETCH_ALL_MAX_ROWS = 10_000

const enc = encodeURIComponent

export class ApiClient {
  readonly apiUrl: string
  readonly contextName: string
  private readonly dashboardUrl?: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private openai: OpenAI | null = null

  constructor(opts: ApiClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.contextName = opts.contextName
    this.dashboardUrl = opts.dashboardUrl?.replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  // v1 returns the official openai client pointed at this server's /v1. No
  // automatic retries, matching the /api helper: the CLI reports a failure
  // and the user decides whether to run the command again.
  async v1(): Promise<OpenAI> {
    if (!this.openai) {
      const { default: OpenAIClient } = await import('openai')
      this.openai = new OpenAIClient({
        apiKey: this.apiKey,
        baseURL: `${this.apiUrl}/v1`,
        maxRetries: 0,
        timeout: this.timeoutMs,
      })
    }
    return this.openai
  }

  // headers omits Authorization when the client has no key, which only the
  // public kit lookup does.
  headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    }
  }

  url(path: string): string {
    return this.apiUrl + path
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: this.headers(init?.headers as Record<string, string> | undefined),
      signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) {
      let body: unknown
      try {
        body = await res.json()
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(`${res.status} ${res.statusText}`, res.status, body)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  // -- Identity -----------------------------------------------------------------

  whoami(): Promise<Whoami> {
    return this.request<Whoami>('/api/whoami')
  }

  // -- API keys -----------------------------------------------------------------

  async listKeys(params?: PageParams): Promise<Page<APIKey>> {
    return toPage(await this.request<ListPage<APIKey>>(`/api/keys${pageQuery({ ...params })}`))
  }

  createKey(name: string): Promise<APIKeyIssued> {
    return this.post<APIKeyIssued>('/api/keys', { name })
  }

  revokeKey(id: string): Promise<void> {
    return this.request<void>(`/api/keys/${enc(id)}`, { method: 'DELETE' })
  }

  // -- Usage and billing --------------------------------------------------------

  usage(params: { start?: number; end?: number; group_by?: string; session?: string }): Promise<UsageSummary> {
    return this.request<UsageSummary>(`/api/usage${pageQuery(params)}`)
  }

  async usageEvents(params: PageParams & { meter?: string }): Promise<Page<UsageEvent>> {
    return toPage(await this.request<ListPage<UsageEvent>>(`/api/usage/events${pageQuery(params)}`))
  }

  wallet(): Promise<Wallet> {
    return this.request<Wallet>('/api/billing/wallet')
  }

  checkout(offer: string): Promise<BillingURL> {
    return this.request<BillingURL>('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ offer }),
      headers: this.returnTo(),
    })
  }

  portal(): Promise<BillingURL> {
    return this.request<BillingURL>('/api/billing/portal', { method: 'POST', headers: this.returnTo() })
  }

  // returnTo names the dashboard to send the user back to; the server keeps
  // it only when it is one of its dashboard origins.
  private returnTo(): Record<string, string> {
    return this.dashboardUrl ? { Origin: this.dashboardUrl } : {}
  }

  // -- Kits ---------------------------------------------------------------------

  async listKits(): Promise<Kit[]> {
    return (await this.request<ListPage<Kit>>('/api/kits')).data
  }

  getKit(id: string): Promise<Kit> {
    return this.request<Kit>(`/api/kits/${enc(id)}`)
  }

  createKit(input: KitInput): Promise<Kit> {
    return this.post<Kit>('/api/kits', input)
  }

  updateKit(id: string, input: Partial<KitInput>): Promise<Kit> {
    return this.request<Kit>(`/api/kits/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
  }

  publishKit(id: string): Promise<Kit> {
    return this.post<Kit>(`/api/kits/${enc(id)}/publish`)
  }

  withdrawKit(id: string): Promise<Kit> {
    return this.post<Kit>(`/api/kits/${enc(id)}/withdraw`)
  }

  // publicKit reads a published kit's public page, which needs no credential.
  publicKit(publicId: string): Promise<PublicKit> {
    return this.request<PublicKit>(`/api/public/kits/${enc(publicId)}`)
  }

  copyKit(publicId: string, assets: KitCopyAsset[]): Promise<KitCopyResult> {
    return this.post<KitCopyResult>(`/api/kits/${enc(publicId)}/copy`, { assets })
  }
}
