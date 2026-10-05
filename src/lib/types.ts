// Wire types for the Orca server's /api routes. The /v1 Agents API types come
// from the `openai` package. Money is micro-USD as the server sends it; the
// CLI formats those figures and never computes one.

// The /v1 list envelope, which the /api list routes share.
export type ListPage<T> = {
  object: 'list'
  data: T[]
  has_more: boolean
  first_id?: string | null
  last_id?: string | null
}

// GET /api/whoami. `agent` is set only for a key scoped to a published agent.
export type Whoami = {
  object: 'whoami'
  tenant: string
  actor: string
  role: string
  agent: string | null
}

// An API key, without its secret. `agent` is the agent a published agent's
// key is scoped to, or null for an organization key.
export type APIKey = {
  id: string
  object: 'api_key'
  name: string
  role: string
  hint: string
  created_by: string
  created_at: number
  last_used_at: number | null
  agent: string | null
}

// POST /api/keys and POST /api/agents/{id}/publish: the only responses that
// ever carry the secret.
export type APIKeyIssued = APIKey & { secret: string }

// -- Usage --------------------------------------------------------------------

export type UsageMeter = {
  meter: string
  unit: string
  quantity: number
  cost_micro_usd: number
  buckets: Record<string, number>
}

export type UsageDay = {
  date: string
  meter: string
  quantity: number
  cost_micro_usd: number
}

export type UsageGroup = {
  meter: string
  key: string | null
  quantity: number
  cost_micro_usd: number
}

// GET /api/usage.
export type UsageSummary = {
  object: 'usage.summary'
  start: number
  end: number
  session_id: string | null
  cost_micro_usd: number
  meters: UsageMeter[]
  daily: UsageDay[]
  groups?: UsageGroup[]
}

// GET /api/usage/events rows.
export type UsageEvent = {
  id: string
  object: 'usage.event'
  meter: string
  unit: string
  bucket: string | null
  quantity: number
  status: string | null
  source: string | null
  session_id: string | null
  subject: string | null
  provider: string | null
  model: string | null
  credential: string | null
  window_start: number
  window_end: number
  recorded_at: number
  cost_micro_usd: number
  rate_id: string | null
  actor: string | null
}

// -- Billing ------------------------------------------------------------------

export type WalletPack = { cents: number; fee_cents: number; credited_micro_usd: number }

// GET /api/billing/wallet.
export type Wallet = {
  object: 'billing.wallet'
  balance_micro_usd: number
  credited_micro_usd: number
  charged_micro_usd: number
  tier: string
  period_start: number
  period_end: number
  included_compute_seconds: number
  used_compute_seconds: number
  packs: WalletPack[]
  processing_fee: { bps: number; flat_cents: number }
}

// POST /api/billing/checkout and /api/billing/portal.
export type BillingURL = { url: string }

// -- Kits ---------------------------------------------------------------------

export type KitSelection = { agents: string[]; skills: string[]; templates: string[] }

// A kit of this organization's own (GET /api/kits).
export type Kit = {
  id: string
  object: 'kit'
  public_id: string | null
  name: string
  description: string
  readme: string
  status: string
  selection: KitSelection
  latest_version: number | null
  created_by: string
  created_at: number
  updated_at: number
}

export type KitInput = {
  name: string
  description?: string
  readme?: string
  selection: Partial<KitSelection>
}

export type PublicKitAsset = { key: string; name: string } & Record<string, unknown>

// A credential the copying organization must add: an MCP server, an MCP
// header, or a template environment variable.
export type KitCredential = { kind: string; name: string; used_by: string } & Record<string, unknown>

// GET /api/public/kits/{public_id}: names and descriptions, never bytes.
export type PublicKit = {
  object: 'kit.public'
  public_id: string
  name: string
  description: string
  readme: string
  version: number
  published_at: number
  contents: { agents: PublicKitAsset[]; skills: PublicKitAsset[]; templates: PublicKitAsset[] }
  credentials: KitCredential[]
}

export type KitCopyAsset = { key: string; name: string }

// POST /api/kits/{public_id}/copy.
export type KitCopyResult = {
  object: 'kit.copy'
  public_id: string
  version: number
  created: { key: string; kind: string; id: string; name: string }[]
  credentials: KitCredential[]
}
