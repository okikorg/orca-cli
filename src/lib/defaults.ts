// Baked-in production defaults so the CLI works against prod with zero URLs
// typed. Every field still follows the standard precedence: an explicit flag
// beats an environment variable, which beats the context config file, which
// beats these defaults. A default of null means "no confirmed value yet";
// the resolver treats it as unset (so, e.g., the browser login flow still
// exits with a "set --dashboard-url or ORCA_DASHBOARD_URL" hint until a real
// value is filled in here).

// Conductor control-plane API. CONFIRMED: dashboard/vercel.json rewrites
// /api/* to this host. (The conductor-production.up.railway.app strings in
// older docs are stale and must not be used.)
export const DEFAULT_API_URL: string | null = 'https://conductor-production-0859.up.railway.app'

// Orca dashboard base URL for the browser login flow. CONFIRMED via
// `vercel project ls` (project agent-orc-dashboard, latest production URL)
// and a live 200 probe.
export const DEFAULT_DASHBOARD_URL: string | null = 'https://agent-orc-dashboard.vercel.app'

// Public chat gateway base URL. CONFIRMED 2026-07-05: taken from the
// conductor's own publicUrl on GET /api/published and verified live
// (/healthz 200, unauthenticated /v1/chat 401).
export const DEFAULT_GATEWAY_URL: string | null =
  'https://chat-gateway-production-b766.up.railway.app'
