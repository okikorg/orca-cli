// Thin fetch client for the conductor's public tenant API, modeled on
// dashboard/src/lib/api.ts. Auth is a bearer tenant API key; the server
// derives the tenant from the key, so no X-Tenant-ID header is sent.
// docs/openapi.sdk.yaml is the endpoint contract.

import { CliError, ExitCode } from './errors.js'
import type {
  AgentProfile,
  APIKeyIssued,
  APIKeyMetadata,
  ControlPlaneAPIKeyIssued,
  ControlPlaneAPIKeyMetadata,
  CreateControlPlaneAPIKeyRequest,
  CreateRunResponse,
  PublishRequest,
  PublishedAgentWithURL,
  RunDetail,
  RegistryInfo,
  RunSummary,
  SubTask,
  Template,
  TemplateVersion,
} from './types.js'

export class ApiError extends Error {
  status: number
  body?: unknown
  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export type Paged<T> = { items: T[]; total: number }

// PageParams are the uniform pagination knobs every list endpoint accepts.
// The server clamps limit to [1, 200] and treats a missing limit as its
// legacy unpaginated request, so an omitted field simply keeps the old shape.
export type PageParams = { limit?: number; offset?: number }

// pageQuery renders limit/offset (and any extra string filters, e.g. ?q=) into
// a query string. Only defined, non-empty values are emitted, so a call with
// no params yields '' and older servers keep receiving their legacy request.
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

export type ApiClientOptions = {
  apiUrl: string
  apiKey: string
  contextName: string
  // JSON request timeout in milliseconds. Streaming requests manage their own.
  timeoutMs?: number
}

// extractErrorBody pulls a human-readable reason out of the JSON body the
// conductor sends on 4xx: { error: "<reason>" } for nearly every handler.
export function extractErrorBody(body: unknown): string {
  if (!body) return ''
  if (typeof body === 'string') return body
  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>
    if (typeof rec.error === 'string') return rec.error
    if (typeof rec.message === 'string') return rec.message
  }
  return ''
}

// mapApiError converts a thrown ApiError/TypeError into the CliError the
// top-level trap renders, distinguishing auth, not-found, server, and
// connectivity failures so the user knows which one to fix.
export function mapApiError(err: unknown, opts: { contextName: string; apiUrl: string }): CliError {
  if (err instanceof CliError) return err
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return new CliError(
        `invalid or revoked API key for context "${opts.contextName}"`,
        ExitCode.Auth,
        ['Run: orca auth login'],
      )
    }
    if (err.status === 403) {
      return new CliError(
        `your API key's role does not allow this action (context "${opts.contextName}")`,
        ExitCode.Auth,
      )
    }
    if (err.status === 404) {
      const reason = extractErrorBody(err.body)
      return new CliError(reason ? `not found: ${reason}` : 'not found', ExitCode.NotFound)
    }
    if (err.status >= 500) {
      return new CliError(`the API server returned ${err.status}; try again in a moment`, ExitCode.Failure)
    }
    const reason = extractErrorBody(err.body)
    return new CliError(reason ? `${err.status}: ${reason}` : err.message, ExitCode.Failure)
  }
  // fetch() rejects with TypeError when it cannot reach the host.
  if (err instanceof TypeError) {
    return new CliError(
      `cannot reach ${opts.apiUrl} (context "${opts.contextName}")`,
      ExitCode.Failure,
      ['Is the conductor running? Check orca auth status.'],
    )
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new CliError(`request to ${opts.apiUrl} timed out`, ExitCode.Failure)
  }
  return err instanceof Error
    ? new CliError(err.message, ExitCode.Failure)
    : new CliError('unknown error', ExitCode.Failure)
}

export class ApiClient {
  readonly apiUrl: string
  readonly contextName: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(opts: ApiClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.contextName = opts.contextName
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
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
    // Some DELETE/POST handlers return an empty 200.
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  // getOrThrow issues a GET and raises ApiError on a non-2xx, sharing the
  // error-body parsing the paged readers both need.
  private async getOrThrow(path: string): Promise<Response> {
    const res = await fetch(this.url(path), {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
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
    return res
  }

  // requestPaged reads a bare-array list endpoint. The total comes from the
  // X-Total-Count header the conductor sets on paginated endpoints, falling
  // back to the array length so the CLI still works against older servers.
  async requestPaged<T>(path: string): Promise<Paged<T>> {
    const res = await this.getOrThrow(path)
    const items = ((await res.json()) ?? []) as T[]
    const header = res.headers.get('X-Total-Count')
    const total = header != null && header !== '' ? Number(header) : items.length
    return { items, total }
  }

  // requestPagedField reads a list endpoint that wraps its rows in an envelope
  // object ({ <field>: T[], total }). It prefers X-Total-Count, then the
  // envelope's own total, then the array length, so both new and old servers
  // report a sane total.
  async requestPagedField<T>(path: string, field: string): Promise<Paged<T>> {
    const res = await this.getOrThrow(path)
    const body = ((await res.json()) ?? {}) as Record<string, unknown>
    const raw = body[field]
    const items = (Array.isArray(raw) ? raw : []) as T[]
    const header = res.headers.get('X-Total-Count')
    const total =
      header != null && header !== ''
        ? Number(header)
        : typeof body.total === 'number'
          ? body.total
          : items.length
    return { items, total }
  }

  // -- Profiles ---------------------------------------------------------------

  listProfiles(params?: PageParams): Promise<Paged<AgentProfile>> {
    return this.requestPaged<AgentProfile>(`/api/profiles${pageQuery({ ...params })}`)
  }

  // Pools, sessions, skills, and MCP servers are bare-array endpoints whose
  // row types live in their command modules; the caller supplies the element
  // type. Sessions accepts a ?q= id/profile substring filter (free text) and a
  // ?profile= exact-profile-name filter, both composable with pagination.
  listPools<T = unknown>(params?: PageParams): Promise<Paged<T>> {
    return this.requestPaged<T>(`/api/pools${pageQuery({ ...params })}`)
  }

  listSessions<T = unknown>(
    params?: PageParams & { q?: string; profile?: string },
  ): Promise<Paged<T>> {
    return this.requestPaged<T>(`/api/sessions${pageQuery({ ...params })}`)
  }

  listSkills<T = unknown>(params?: PageParams): Promise<Paged<T>> {
    return this.requestPaged<T>(`/api/skills${pageQuery({ ...params })}`)
  }

  listMcpServers<T = unknown>(params?: PageParams): Promise<Paged<T>> {
    return this.requestPaged<T>(`/api/mcp-servers${pageQuery({ ...params })}`)
  }

  listSecrets<T = unknown>(params?: PageParams): Promise<Paged<T>> {
    return this.requestPagedField<T>(`/api/secrets${pageQuery({ ...params })}`, 'secrets')
  }

  // -- Templates --------------------------------------------------------------
  // Harness templates. The list is paginated and enveloped; the per-template
  // version list is not paginated server-side (a template holds a handful of
  // versions), so it is read whole.

  // Where this tenant pushes harness images, so a deploy does not need the
  // caller to bring a registry.
  getRegistry(): Promise<RegistryInfo> {
    return this.request<RegistryInfo>('/api/registry')
  }

  listTemplates(params?: PageParams): Promise<Paged<Template>> {
    return this.requestPagedField<Template>(
      `/api/templates${pageQuery({ ...params })}`,
      'templates',
    )
  }

  getTemplate(name: string): Promise<Template> {
    return this.request<Template>(`/api/templates/${encodeURIComponent(name)}`)
  }

  createTemplate(body: { name: string; description?: string }): Promise<Template> {
    return this.request<Template>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  deleteTemplate(name: string): Promise<void> {
    return this.request<void>(`/api/templates/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  }

  listTemplateVersions(name: string): Promise<Paged<TemplateVersion>> {
    return this.requestPagedField<TemplateVersion>(
      `/api/templates/${encodeURIComponent(name)}/versions`,
      'versions',
    )
  }

  // Answers 202 with a pending version: the image is mirrored into the
  // platform registry by a separate service, so the returned row is a receipt
  // rather than a finished import.
  importTemplateVersion(name: string, image: string): Promise<TemplateVersion> {
    return this.request<TemplateVersion>(
      `/api/templates/${encodeURIComponent(name)}/versions`,
      { method: 'POST', body: JSON.stringify({ image }) },
    )
  }

  activateTemplateVersion(name: string, version: number): Promise<Template> {
    return this.request<Template>(
      `/api/templates/${encodeURIComponent(name)}/versions/${version}/activate`,
      { method: 'POST' },
    )
  }

  getProfile(name: string): Promise<AgentProfile> {
    return this.request<AgentProfile>(`/api/profiles/${encodeURIComponent(name)}`)
  }

  createProfile(profile: AgentProfile): Promise<AgentProfile> {
    return this.request<AgentProfile>('/api/profiles', {
      method: 'POST',
      body: JSON.stringify(profile),
    })
  }

  updateProfile(name: string, profile: AgentProfile): Promise<AgentProfile> {
    return this.request<AgentProfile>(`/api/profiles/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(profile),
    })
  }

  deleteProfile(name: string): Promise<void> {
    return this.request<void>(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  // -- Runs ---------------------------------------------------------------------

  createRun(input: SubTask): Promise<CreateRunResponse> {
    return this.request<CreateRunResponse>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  listRuns(params?: PageParams): Promise<Paged<RunSummary>> {
    return this.requestPaged<RunSummary>(`/api/runs${pageQuery({ ...params })}`)
  }

  listProfileRuns(profile: string, params?: PageParams): Promise<Paged<RunSummary>> {
    return this.requestPaged<RunSummary>(
      `/api/profiles/${encodeURIComponent(profile)}/runs${pageQuery({ ...params })}`,
    )
  }

  listSessionRuns(sessionId: string, params?: PageParams): Promise<Paged<RunSummary>> {
    return this.requestPaged<RunSummary>(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs${pageQuery({ ...params })}`,
    )
  }

  getRun(id: string): Promise<RunDetail> {
    return this.request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`)
  }

  cancelRun(id: string): Promise<void> {
    return this.request<void>(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // -- Publishing (public chat gateway) ----------------------------------------

  getPublishedAgent(profileName: string): Promise<PublishedAgentWithURL> {
    return this.request<PublishedAgentWithURL>(
      `/api/profiles/${encodeURIComponent(profileName)}/published`,
    )
  }

  publishAgent(profileName: string, req: PublishRequest): Promise<PublishedAgentWithURL> {
    return this.request<PublishedAgentWithURL>(
      `/api/profiles/${encodeURIComponent(profileName)}/publish`,
      { method: 'POST', body: JSON.stringify(req) },
    )
  }

  unpublishAgent(profileName: string): Promise<void> {
    return this.request<void>(`/api/profiles/${encodeURIComponent(profileName)}/published`, {
      method: 'DELETE',
    })
  }

  listPublishedAgents(params?: PageParams): Promise<Paged<PublishedAgentWithURL>> {
    return this.requestPagedField<PublishedAgentWithURL>(
      `/api/published${pageQuery({ ...params })}`,
      'publishedAgents',
    )
  }

  listAgentKeys(profileName: string, params?: PageParams): Promise<Paged<APIKeyMetadata>> {
    return this.requestPagedField<APIKeyMetadata>(
      `/api/profiles/${encodeURIComponent(profileName)}/keys${pageQuery({ ...params })}`,
      'keys',
    )
  }

  issueAgentKey(profileName: string, req: { label?: string; expiresAt?: string }): Promise<APIKeyIssued> {
    return this.request<APIKeyIssued>(`/api/profiles/${encodeURIComponent(profileName)}/keys`, {
      method: 'POST',
      body: JSON.stringify(req),
    })
  }

  revokeAgentKey(profileName: string, keyId: string): Promise<void> {
    return this.request<void>(
      `/api/profiles/${encodeURIComponent(profileName)}/keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
    )
  }

  // -- Control-plane API keys ---------------------------------------------------

  listControlPlaneKeys(): Promise<ControlPlaneAPIKeyMetadata[]> {
    return this.request<{ keys: ControlPlaneAPIKeyMetadata[] }>('/api/api-keys').then(
      (res) => res.keys ?? [],
    )
  }

  createControlPlaneKey(body: CreateControlPlaneAPIKeyRequest): Promise<ControlPlaneAPIKeyIssued> {
    return this.request<ControlPlaneAPIKeyIssued>('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  revokeControlPlaneKey(id: string): Promise<void> {
    return this.request<void>(`/api/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}
