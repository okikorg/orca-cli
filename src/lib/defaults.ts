// Baked-in production defaults so the CLI works against prod with zero URLs
// typed. Every field still follows the standard precedence: an explicit flag
// beats an environment variable, which beats the context config file, which
// beats these defaults. A default of null means "no confirmed value yet";
// the resolver treats it as unset (so, e.g., the browser login flow still
// exits with a "set --dashboard-url or ORCA_DASHBOARD_URL" hint until a real
// value is filled in here).

// Conductor control-plane API. CONFIRMED 2026-08-20: api.orcapods.ai fronts
// the production conductor (live probes: /healthz 200, /api/openapi.yaml 200,
// device-code flow end to end). Always prefer the first-party domain over raw
// host URLs so installed CLIs survive infrastructure moves.
export const DEFAULT_API_URL: string | null = 'https://api.orcapods.ai'

// Former baked-in default (raw Railway hostname, leaked into login banners
// and whoami output up to cli-v0.4.0). Context resolution and auth login
// upgrade this exact saved value to the current domain; user-supplied custom
// API URLs are untouched.
export const LEGACY_DEFAULT_API_URL = 'https://conductor-production-0859.up.railway.app'

// Orca dashboard base URL for the browser login flow. CONFIRMED 2026-08-08
// from the agent-orc-dashboard Vercel project's production domains and a
// live 200 probe of /cli-auth.
export const DEFAULT_DASHBOARD_URL: string | null = 'https://app.orcapods.ai'

// Former baked-in default. Auth login upgrades this exact saved value to the
// current production domain; user-supplied custom dashboard URLs are untouched.
export const LEGACY_DEFAULT_DASHBOARD_URL = 'https://agent-orc-dashboard.vercel.app'

// Public chat gateway base URL. CONFIRMED 2026-07-05: taken from the
// conductor's own publicUrl on GET /api/published and verified live
// (/healthz 200, unauthenticated /v1/chat 401).
export const DEFAULT_GATEWAY_URL: string | null =
  'https://chat-gateway-production-b766.up.railway.app'
