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

// The series' bucket, which the server picks from the window: a UTC hour
// for up to 2 days, a UTC day for up to 366 days.
export type UsageSeriesInterval = 'hour' | 'day'

// One meter in one bucket; start is the bucket's start in Unix seconds.
export type UsageSeriesPoint = {
  start: number
  meter: string
  quantity: number
  cost_micro_usd: number
}

// Every bucket of the window for every meter, empty ones at zero; null for a
// window over 366 days.
export type UsageSeries = {
  interval: UsageSeriesInterval
  points: UsageSeriesPoint[]
}

export type UsageGroup = {
  meter: string
  key: string | null
  quantity: number
  cost_micro_usd: number
}

// One key's cost across every meter: with group_by, they sum to the
// summary's cost. A call's money is on its model_calls row, not its tokens,
// so a model's, session's or agent's cost is read from here.
export type UsageGroupCost = {
  key: string | null
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
  // Absent only from a server older than the series.
  series?: UsageSeries | null
  groups?: UsageGroup[]
  group_costs?: UsageGroupCost[]
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
  // Where the row's money is when another row carries it: its call's
  // model_calls row, its search's web_searches row, or the late_charges row
  // that charged a call whose cost was not reported when it ended. Null when
  // the row's own cost is its charge.
  charged_on?: ChargedOn | null
  // On a late_charges row, the id of the row it charges: `<attempt>:call` for
  // a model call, `<attempt>:search` for a web search, named even when the
  // call left no rows. Null on every other row.
  charge_for?: string | null
}

export type ChargedOn = 'call' | 'search' | 'late'

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

// -- Sandbox sleep ------------------------------------------------------------

// Where a session's hosted sandbox is: none for no sandbox or a self-hosted
// one.
export type SandboxState = 'none' | 'awake' | 'going_to_sleep' | 'asleep' | 'waking'

// The newest sleep since the sandbox last woke, whoever started it. reason is
// an open string (requested, idle, out_of_credit, hours_used_up, unpriced,
// and more later); outcome is null while it is going to sleep.
export type SandboxSleep = {
  reason: string
  started_at: number
  finished_at: number | null
  outcome: 'asleep' | 'too_large' | 'failed' | 'interrupted' | null
  message: string | null
}

// GET /api/sessions/{id}/sandbox and POST /api/sessions/{id}/sandbox/sleep.
export type SessionSandbox = {
  object: 'session.sandbox'
  session_id: string
  environment_id: string | null
  state: SandboxState
  last_sleep: SandboxSleep | null
}

// POST /api/billing/checkout and /api/billing/portal.
export type BillingURL = { url: string }

// -- Kits ---------------------------------------------------------------------

// A credential the copying organization must add: an MCP server's goes in a
// vault, a variable is set on the copied template. `asset` is the kit key
// needing it.
export type KitCredential = {
  kind: 'mcp_server' | 'environment_variable'
  name: string
  used_by: string
  asset: string
  server_url?: string | null
}

// One file of a skill, inline capability or template, as the review shows
// it: always its path, size and SHA-256; its content in full, or null with
// hash_only saying why (binary, longer_than_64_kib, review_limit).
export type KitReviewFile = {
  path: string
  size_bytes: number
  sha256: string
  content: string | null
  hash_only: string | null
}

// An agent's tool as the review shows it. An HTTP MCP server's headers are
// listed by name only, a stdio one's environment by variable name.
export type KitReviewTool =
  | { type: 'web_search'; mode?: string | null; context_size?: string | null; allowed_domains?: string[] | null }
  | { type: 'function'; name: string; description?: string | null }
  | {
      type: 'mcp'
      server_label: string
      allowed_tools?: string[] | null
      required?: boolean | null
      request_metadata_keys?: string[]
      transport:
        | { type: 'http'; server_url: string; header_names: string[] }
        | { type: 'stdio'; command: string; args?: string[] | null; cwd?: string | null; env_var_names?: string[] | null }
    }
  | { type: string }

export type KitReviewAgent = {
  key: string
  name: string
  model: string | null
  reasoning_effort: string | null
  service_tier: string | null
  team: { enabled: boolean; max_concurrent_subagents: number | null }
  instructions: string | null
  tools: KitReviewTool[]
}

export type KitReviewSkill = { key: string; name: string; description: string | null; files: KitReviewFile[] }

// A template's skill or plugin: a kit skill by its key, or an inline one with
// its files.
export type KitReviewCapability =
  | { type: 'kit_skill'; key: string }
  | { type: 'inline'; name: string; description: string | null; files: KitReviewFile[] }

export type KitReviewTemplate = {
  key: string
  name: string
  network: { access: string | null; allowed_domains?: string[] | null }
  packages: { system?: string[] | null; python?: string[] | null; npm?: string[] | null } | null
  setup_commands: { command: string; cwd?: string | null }[] | null
  capability_directories: string[] | null
  files: KitReviewFile[]
  skills: KitReviewCapability[]
  plugins: KitReviewCapability[]
}

// GET /api/public/kits/{public_id}/review: everything the newest version of
// one of Orca's kits puts in an organization, built by the server. The
// summaries are the server's, so no client decides what is risky.
export type KitReview = {
  object: 'kit.review'
  public_id: string
  version: number
  published_at: number
  publisher: { orca?: boolean }
  name: string
  description: string
  summary: { runs_code: string[]; reaches: string[]; spends: string[] }
  agents: KitReviewAgent[]
  skills: KitReviewSkill[]
  templates: KitReviewTemplate[]
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
