// Wire types for the conductor's public tenant API, copied as a subset of
// dashboard/src/lib/types.ts. docs/openapi.sdk.yaml is the contract; check
// there when the backend changes.

export type MCPServerSpec = {
  name: string
  transport: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

export type FSPolicy = {
  read?: string[]
  write?: string[]
  delete?: string[]
  deny?: string[]
  // Explicit per-session VFS mount allowlist. JSON key matches the Go wire
  // format (snake_case); the rest of FSPolicy is lowercase by legacy convention.
  allow_mounts?: string[]
}

export type SandboxResources = {
  cpu?: number
  memoryMB?: number
  diskMB?: number
  timeout?: number
}

export type SandboxSpec = {
  provider: string
  template?: string
  resources?: SandboxResources
  env?: Record<string, string>
  idleTimeout?: number // nanoseconds, matches Go time.Duration
}

export type AgentProfile = {
  id?: string
  name: string
  // "general" is the deprecated pre-rename label for "vercel" and may still
  // be returned for older stored profiles.
  runtime: 'pi' | 'vercel' | 'claude' | 'codex' | 'general'
  systemPrompt?: string
  skills?: string[]
  mcpServers?: MCPServerSpec[]
  model?: string
  tools?: string[]
  fs?: FSPolicy
  sandbox?: SandboxSpec
}

export type SubTask = {
  id?: string
  parentId?: string
  profile: string
  sessionId?: string
  title: string
  prompt?: string
  files?: string[]
}

export type RunEventType =
  | 'progress'
  | 'result'
  | 'error'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'usage'

export type Usage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
}

export type RunEvent = {
  type: RunEventType
  message?: string
  ts?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  isError?: boolean
  usage?: Usage
}

// 'interrupted' is stamped by the conductor's boot reconciliation sweep on
// runs orphaned by a crash or redeploy: terminal, but neither ok nor error.
export type RunStatus = 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted'

export type RunSummary = {
  id: string
  subTask: SubTask
  status: RunStatus
  startedAt: string
  finishedAt?: string
}

export type RunDetail = RunSummary & { events: RunEvent[] }

export type CreateRunResponse = {
  runId: string
  sessionId: string
}

// -- Publishing (public chat gateway) ----------------------------------------

export type PublishedAgent = {
  id: string
  tenantId: string
  profileName: string
  slug: string
  visibility: 'private' | 'org' | 'public'
  authMode: 'api_key' | 'jwt'
  allowedOrigins: string[]
  rateLimitRpm: number
  syncMaxDurationSeconds: number
  conversationTtlDays: number | null
  exposeToolEvents: boolean
  enabled: boolean
  unpublishedAt: string | null
  createdAt: string
  updatedAt: string
}

export type PublishedAgentWithURL = PublishedAgent & { publicUrl: string }

export type PublishRequest = {
  slug?: string
  visibility?: 'private' | 'org' | 'public'
  authMode?: 'api_key' | 'jwt'
  allowedOrigins?: string[]
  rateLimitRpm?: number
  syncMaxDurationSeconds?: number
  conversationTtlDays?: number | null
  exposeToolEvents?: boolean
}

// Per-published-agent chat keys, verified by the gateway on /v1/chat.
export type APIKeyMetadata = {
  id: string
  publishedId: string
  label: string
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export type APIKeyIssued = APIKeyMetadata & { token: string }

// -- Control-plane API keys (tenant-to-server, RBAC) --------------------------
// Durable bearer keys for /api/*. A key inherits its minter's role.

export type ControlPlaneAPIKeyMetadata = {
  id: string
  tenantId: string
  name: string
  role: string
  createdBy: string
  createdAt: string
  lastUsedAt?: string | null
  revokedAt?: string | null
  expiresAt?: string | null
}

export type CreateControlPlaneAPIKeyRequest = {
  name: string
  expiresAt?: string
}

export type ControlPlaneAPIKeyIssued = ControlPlaneAPIKeyMetadata & {
  token: string
}
