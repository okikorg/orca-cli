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

// GET /api/whoami.
export type Whoami = {
  object: 'whoami'
  tenant: string
  actor: string
  role: string
}

// An API key, without its secret.
export type APIKey = {
  id: string
  object: 'api_key'
  name: string
  role: string
  hint: string
  created_by: string
  created_at: number
  last_used_at: number | null
}

// POST /api/keys: the only response that ever carries the secret.
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
  // The tier's minimum balance for paid work.
  min_balance_micro_usd: number
  // The gate's own verdict: paid work is refused until a top-up. The CLI
  // shows it and never compares the balance with a threshold.
  paid_work_paused: boolean
  tier: string
  period_start: number
  period_end: number
  included_compute_seconds: number
  used_compute_seconds: number
  packs: WalletPack[]
  processing_fee: { bps: number; flat_cents: number }
  // OpenRouter's credit fee on tokens and searches on Orca credit, in basis
  // points. The CLI shows it and does no arithmetic with it.
  openrouter_fee_bps: number
}

// -- Models -------------------------------------------------------------------

// Who pays for a model's calls (orca-design model-billing D3.13).
export type Payer = 'orca_credit' | 'own_key'

// One model a member can pick. Prices are OpenRouter's, Orca credit only, in
// micro-USD per million tokens; null where OpenRouter has no fixed price.
export type PickModel = {
  id: string
  name?: string
  context_length?: number
  input_micro_usd_per_million?: number | null
  output_micro_usd_per_million?: number | null
}

export type ModelGroup = {
  payer: Payer
  provider: string
  label: string
  // False when the server could not read this list; it then has no models.
  available: boolean
  models: PickModel[]
}

// GET /api/models: Orca credit first, then one group per provider with a key.
export type ModelGroups = { object: 'list'; openrouter_fee_bps: number; groups: ModelGroup[] }

// GET and POST /api/sessions/{id}/model.
export type SessionModel = {
  object: 'session.model'
  session_id: string
  model: string
  agent_model: string
  payer: Payer | null
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
  // The share link, from the server, which knows the dashboard's origin.
  url: string | null
  name: string
  description: string
  // Who the kit's public page says it is by; empty when unset.
  author: string
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
  author?: string
  readme?: string
  selection: Partial<KitSelection>
}

export type PublicKitAsset = { key: string; name: string } & Record<string, unknown>

// A credential the copying organization must add: an MCP server, an MCP
// header, or a template environment variable.
// A credential a copied kit needs: an MCP server's goes in a vault, a
// variable is set on the copied template. `asset` is the kit key needing it.
export type KitCredential = {
  kind: 'mcp_server' | 'environment_variable'
  name: string
  used_by: string
  asset: string
  server_url?: string | null
}

// GET /api/public/kits/{public_id}: names and descriptions, never bytes.
export type PublicKit = {
  object: 'kit.public'
  public_id: string
  // The share link, built by the server.
  url: string
  name: string
  description: string
  // The author the published version was snapshotted with; may be empty.
  author: string
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
