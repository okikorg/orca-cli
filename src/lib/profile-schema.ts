// Client-side schema validation for agent profiles, copied from
// dashboard/src/lib/agent-profile-schema.ts (keep the two in sync).
//
// The CLI creates/updates agents from a YAML or JSON document. Before we
// POST anything to the backend we parse the document and validate it here so
// the user gets precise, field-level feedback rather than an opaque 400 from
// the server.
//
// This validator is intentionally strict about *shape* (types, enums,
// required fields) and lenient about *values* the backend owns (e.g. whether
// a model id or skill name actually exists). Unknown keys are reported as
// warnings so a slightly-off document surfaces the likely typo without
// blocking the import.

import type { AgentProfile, MCPServerSpec } from './types.js'

export const RUNTIMES = ['pi', 'vercel', 'claude', 'codex', 'marlin'] as const
export type Runtime = (typeof RUNTIMES)[number]

// Profiles created before the Vercel runtime rename may still use the legacy
// "general" label. Match the platform by accepting and canonicalising it.
export function normalizeRuntime(runtime: string): string {
  return runtime === 'general' ? 'vercel' : runtime
}

// Top-level keys we recognise. Anything else is surfaced as a warning so a
// user who wrote `runtimes:` or `model_name:` finds out immediately.
const KNOWN_KEYS = new Set([
  'id',
  'name',
  'runtime',
  'systemPrompt',
  'skills',
  'mcpServers',
  'model',
  'tools',
  'fs',
  'sandbox',
  'workerMode',
  'workerSubstrate',
  'workerImage',
])

// Worker modes accepted on import. An omitted value means 'static', which is
// what the API assumes for every profile written before this field existed.
const WORKER_MODES = new Set(['static', 'sandbox'])

// Where a per-session worker can boot. Advisory only on import: which of these
// a given runner actually serves is deployment configuration, not schema.
const WORKER_SUBSTRATES = new Set(['e2b', 'daytona', 'docker', 'process'])

const KNOWN_MCP_KEYS = new Set(['name', 'transport', 'url', 'headers', 'ref', 'optional'])
const KNOWN_FS_KEYS = new Set(['read', 'write', 'delete', 'deny', 'allow_mounts'])
const KNOWN_SANDBOX_KEYS = new Set([
  'provider',
  'template',
  'resources',
  'env',
  'idleTimeout',
])
const KNOWN_RESOURCE_KEYS = new Set(['cpu', 'memoryMB', 'diskMB', 'timeout'])

export type SchemaValidation = {
  ok: boolean
  // Fatal problems that block the import.
  errors: string[]
  // Non-fatal notes (unknown keys, etc.) - shown but don't block.
  warnings: string[]
  // The normalised profile, present only when ok is true.
  profile?: AgentProfile
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

// Validate a raw string→string map (headers, sandbox env). Returns the
// cleaned map or null if any entry is malformed.
function validateStringMap(
  v: unknown,
  label: string,
  errors: string[],
): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  if (!isPlainObject(v)) {
    errors.push(`${label} must be a map of string keys to string values`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') {
      errors.push(`${label}.${k} must be a string`)
      continue
    }
    out[k] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function validateMcpServers(
  v: unknown,
  errors: string[],
  warnings: string[],
): MCPServerSpec[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) {
    errors.push('mcpServers must be a list')
    return undefined
  }
  const out: MCPServerSpec[] = []
  const seen = new Set<string>()
  v.forEach((raw, i) => {
    const at = `mcpServers[${i}]`
    if (!isPlainObject(raw)) {
      errors.push(`${at} must be an object`)
      return
    }
    for (const k of Object.keys(raw)) {
      if (!KNOWN_MCP_KEYS.has(k)) warnings.push(`${at}: unknown key "${k}"`)
    }
    const name = raw.name
    const transport = raw.transport
    const url = raw.url
    const ref = raw.ref

    if (typeof name !== 'string' || !name.trim()) {
      errors.push(`${at}.name is required`)
    } else if (name.trim() === 'runner') {
      errors.push(`${at}.name "runner" is reserved`)
    } else if (seen.has(name.trim())) {
      errors.push(`${at}.name "${name.trim()}" is duplicated`)
    } else {
      seen.add(name.trim())
    }

    // A catalog reference (Connected Apps grant) carries no transport of its
    // own: it must be exactly `catalog://<name>` with no url/headers, mirroring
    // the API's validateMCPServerSpec. Everything else is an inline server and
    // needs transport + url.
    if (ref !== undefined) {
      if (typeof ref !== 'string' || typeof name !== 'string' || ref !== `catalog://${name.trim()}`) {
        errors.push(`${at}.ref must be "catalog://<name>" (matching the entry's name)`)
      }
      if (url !== undefined || raw.headers !== undefined) {
        errors.push(`${at}: a catalog ref must not copy url or headers`)
      }
      if (
        typeof name === 'string' &&
        typeof ref === 'string' &&
        ref === `catalog://${name.trim()}` &&
        url === undefined &&
        raw.headers === undefined
      ) {
        out.push({ name: name.trim(), ref, ...(raw.optional === true ? { optional: true } : {}) })
      }
      return
    }

    if (transport !== 'http' && transport !== 'sse') {
      errors.push(`${at}.transport must be "http" or "sse"`)
    }

    if (typeof url !== 'string' || !url.trim()) {
      errors.push(`${at}.url is required`)
    } else {
      try {
        const parsed = new URL(url.trim())
        if (!parsed.protocol.startsWith('http')) {
          errors.push(`${at}.url must be an absolute http(s) URL`)
        }
      } catch {
        errors.push(`${at}.url must be a valid absolute URL`)
      }
    }

    const headers = validateStringMap(raw.headers, `${at}.headers`, errors)
    if (typeof name === 'string' && (transport === 'http' || transport === 'sse') && typeof url === 'string') {
      out.push({
        name: name.trim(),
        transport,
        url: url.trim(),
        ...(headers ? { headers } : {}),
      })
    }
  })
  return out.length > 0 ? out : undefined
}

function validateFs(
  v: unknown,
  errors: string[],
  warnings: string[],
): AgentProfile['fs'] {
  if (v === undefined || v === null) return undefined
  if (!isPlainObject(v)) {
    errors.push('fs must be an object')
    return undefined
  }
  for (const k of Object.keys(v)) {
    if (!KNOWN_FS_KEYS.has(k)) warnings.push(`fs: unknown key "${k}"`)
  }
  const fs: NonNullable<AgentProfile['fs']> = {}
  for (const key of ['read', 'write', 'delete', 'deny', 'allow_mounts'] as const) {
    const val = v[key]
    if (val === undefined) continue
    if (!isStringArray(val)) {
      errors.push(`fs.${key} must be a list of strings`)
      continue
    }
    if (val.length > 0) fs[key] = val
  }
  return Object.keys(fs).length > 0 ? fs : undefined
}

function validateSandbox(
  v: unknown,
  errors: string[],
  warnings: string[],
): AgentProfile['sandbox'] {
  if (v === undefined || v === null) return undefined
  if (!isPlainObject(v)) {
    errors.push('sandbox must be an object')
    return undefined
  }
  for (const k of Object.keys(v)) {
    if (!KNOWN_SANDBOX_KEYS.has(k)) warnings.push(`sandbox: unknown key "${k}"`)
  }
  const provider = v.provider
  if (typeof provider !== 'string' || !provider.trim()) {
    errors.push('sandbox.provider is required when sandbox is set')
  }

  if (v.template !== undefined && typeof v.template !== 'string') {
    errors.push('sandbox.template must be a string')
  }
  if (v.idleTimeout !== undefined && typeof v.idleTimeout !== 'number') {
    errors.push('sandbox.idleTimeout must be a number (nanoseconds)')
  }

  let resources: NonNullable<AgentProfile['sandbox']>['resources']
  if (v.resources !== undefined) {
    if (!isPlainObject(v.resources)) {
      errors.push('sandbox.resources must be an object')
    } else {
      for (const k of Object.keys(v.resources)) {
        if (!KNOWN_RESOURCE_KEYS.has(k)) {
          warnings.push(`sandbox.resources: unknown key "${k}"`)
        }
      }
      const r: NonNullable<NonNullable<AgentProfile['sandbox']>['resources']> = {}
      for (const key of ['cpu', 'memoryMB', 'diskMB', 'timeout'] as const) {
        const val = v.resources[key]
        if (val === undefined) continue
        if (typeof val !== 'number') {
          errors.push(`sandbox.resources.${key} must be a number`)
          continue
        }
        r[key] = val
      }
      if (Object.keys(r).length > 0) resources = r
    }
  }

  const env = validateStringMap(v.env, 'sandbox.env', errors)

  if (typeof provider !== 'string' || !provider.trim()) return undefined
  return {
    provider: provider.trim(),
    ...(typeof v.template === 'string' && v.template ? { template: v.template } : {}),
    ...(resources ? { resources } : {}),
    ...(env ? { env } : {}),
    ...(typeof v.idleTimeout === 'number' ? { idleTimeout: v.idleTimeout } : {}),
  }
}

// validateProfile takes an already-parsed YAML/JSON value and returns a
// normalised AgentProfile plus any errors/warnings. It never throws.
export function validateProfile(raw: unknown): SchemaValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: ['Document must be a YAML mapping (key: value pairs) describing an agent'],
      warnings,
    }
  }

  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) warnings.push(`Unknown top-level key "${k}"`)
  }

  // name - required
  const name = raw.name
  if (typeof name !== 'string' || !name.trim()) {
    errors.push('name is required and must be a non-empty string')
  }

  // runtime - required enum ("general" remains a deprecated alias for
  // vercel so existing profile files continue to import cleanly)
  const runtime =
    typeof raw.runtime === 'string' ? normalizeRuntime(raw.runtime) : raw.runtime
  if (typeof runtime !== 'string' || !RUNTIMES.includes(runtime as Runtime)) {
    errors.push(`runtime is required and must be one of: ${RUNTIMES.join(', ')}`)
  } else if (raw.runtime === 'general') {
    warnings.push('runtime "general" is deprecated; it was imported as "vercel"')
  }

  if (raw.id !== undefined && typeof raw.id !== 'string') {
    errors.push('id must be a string')
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') {
    errors.push('model must be a string')
  }
  if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') {
    errors.push('systemPrompt must be a string')
  }
  if (raw.skills !== undefined && !isStringArray(raw.skills)) {
    errors.push('skills must be a list of strings')
  }
  if (raw.tools !== undefined && !isStringArray(raw.tools)) {
    errors.push('tools must be a list of strings')
  }

  // An unrecognised workerMode is an error rather than a warning: silently
  // dropping it would import the profile as 'static', and the user would have
  // no way to tell from the result that their sandbox request was ignored.
  if (
    raw.workerMode !== undefined &&
    raw.workerMode !== '' &&
    (typeof raw.workerMode !== 'string' || !WORKER_MODES.has(raw.workerMode))
  ) {
    errors.push(`workerMode must be one of: ${[...WORKER_MODES].join(', ')}`)
  }
  if (runtime === 'marlin' && raw.workerMode !== 'sandbox') {
    errors.push('runtime "marlin" requires workerMode "sandbox"')
  }
  if (raw.workerSubstrate !== undefined && typeof raw.workerSubstrate !== 'string') {
    errors.push('workerSubstrate must be a string')
  } else if (
    typeof raw.workerSubstrate === 'string' &&
    raw.workerSubstrate.trim() &&
    !WORKER_SUBSTRATES.has(raw.workerSubstrate.trim())
  ) {
    // A warning, not an error, unlike workerMode above. Which substrates exist
    // is a property of the runner rather than of this schema, so a name this
    // build has not heard of may still be valid on the deployment being
    // imported into. A genuinely wrong one fails loudly at the session's first
    // run, naming what the runner does serve.
    warnings.push(
      `Unrecognised workerSubstrate "${raw.workerSubstrate.trim()}" (known: ${[...WORKER_SUBSTRATES].join(', ')})`,
    )
  }
  if (raw.workerImage !== undefined && typeof raw.workerImage !== 'string') {
    errors.push('workerImage must be a string')
  }
  // Both worker placement fields are inert on a static profile, and silently
  // keeping them is how a profile ends up carrying config that looks live.
  if (raw.workerMode !== 'sandbox' && (raw.workerSubstrate || raw.workerImage)) {
    warnings.push('workerSubstrate/workerImage only apply when workerMode is "sandbox"; dropped')
  }

  const mcpServers = validateMcpServers(raw.mcpServers, errors, warnings)
  const fs = validateFs(raw.fs, errors, warnings)
  const sandbox = validateSandbox(raw.sandbox, errors, warnings)

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  const profile: AgentProfile = {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    name: (name as string).trim(),
    runtime: runtime as Runtime,
    ...(typeof raw.model === 'string' && raw.model.trim()
      ? { model: raw.model.trim() }
      : {}),
    ...(typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()
      ? { systemPrompt: raw.systemPrompt.trim() }
      : {}),
    ...(isStringArray(raw.skills) && raw.skills.length > 0
      ? { skills: raw.skills }
      : {}),
    ...(isStringArray(raw.tools) && raw.tools.length > 0
      ? { tools: raw.tools }
      : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(fs ? { fs } : {}),
    ...(sandbox ? { sandbox } : {}),
    // Omit 'static' rather than writing it out: it is the API default, and a
    // round-tripped export should not sprout a field the user never set.
    ...(raw.workerMode === 'sandbox' ? { workerMode: 'sandbox' as const } : {}),
    // Both are only meaningful for a per-session worker, and both are dropped
    // for a static profile rather than carried silently: importing a sandbox
    // agent as static and keeping its substrate would leave a field that reads
    // like it does something and does not.
    ...(raw.workerMode === 'sandbox' &&
    typeof raw.workerSubstrate === 'string' &&
    raw.workerSubstrate.trim()
      ? { workerSubstrate: raw.workerSubstrate.trim() }
      : {}),
    ...(raw.workerMode === 'sandbox' && typeof raw.workerImage === 'string' && raw.workerImage.trim()
      ? { workerImage: raw.workerImage.trim() }
      : {}),
  }

  return { ok: true, errors, warnings, profile }
}
