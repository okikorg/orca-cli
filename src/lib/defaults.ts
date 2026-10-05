// Baked-in production defaults so the CLI works against prod with zero URLs
// typed. Every field still follows the standard precedence: an explicit flag
// beats an environment variable, which beats the context config file, which
// beats these defaults. A default of null means "no confirmed value yet";
// the resolver treats it as unset.

// The Orca server: the /api routes and the /v1 Agents API. Always prefer the
// first-party domain over raw host URLs so installed CLIs survive
// infrastructure moves.
export const DEFAULT_API_URL: string | null = 'https://api.orcapods.ai'

// Former baked-in default (raw Railway hostname, leaked into login banners
// and whoami output up to cli-v0.4.0). Context resolution and auth login
// upgrade this exact saved value to the current domain; user-supplied custom
// API URLs are untouched.
export const LEGACY_DEFAULT_API_URL = 'https://conductor-production-0859.up.railway.app'

// The Orca dashboard, where a published kit's public page lives. Device
// login replaces it with the origin of the server's verification page, so a
// local or staging server's kit links point at its own dashboard.
export const DEFAULT_DASHBOARD_URL: string | null = 'https://app.orcapods.ai'
