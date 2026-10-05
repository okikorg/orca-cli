import os from 'node:os'

import type { Command } from 'commander'

import { ApiClient, mapApiError } from '../lib/api.js'
import { openBrowser } from '../lib/browser.js'
import {
  DEFAULT_CONTEXT,
  loadConfig,
  maskKey,
  resolveContext,
  saveConfig,
  type ContextConfig,
  type DefaultableField,
} from '../lib/config.js'
import { DEFAULT_API_URL, LEGACY_DEFAULT_API_URL } from '../lib/defaults.js'
import { pollDeviceToken, requestDeviceCode, type DeviceCodeResponse } from '../lib/device-flow.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { interactive, outputMode, printJson, renderStatic } from '../lib/output.js'
import type { Whoami } from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirmDestructive } from './prompts.js'
import { globalFlags } from './shared.js'

// whoamiFor asks the server who a key acts as. Every role can read it, so it
// doubles as the key check for login and status.
async function whoamiFor(apiUrl: string, apiKey: string, contextName: string): Promise<Whoami> {
  const client = new ApiClient({ apiUrl, apiKey, contextName })
  try {
    return await client.whoami()
  } catch (err) {
    throw mapApiError(err, { contextName, apiUrl })
  }
}

// normalizeUrl trims a trailing slash and enforces an http(s) scheme.
function normalizeUrl(raw: string, label: string): string {
  const url = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(url)) {
    throw new CliError(`${label} must start with http:// or https://: ${url}`, ExitCode.Usage)
  }
  return url
}

// agentContext sniffs the environment for the coding agent (or headless
// context) driving this login, so no browser is opened and the key label says
// who minted it. Returns a label prefix, or null when this looks like a human
// at a terminal.
function agentContext(): string | null {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return 'claude-code'
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  if (process.env.CI) return 'ci'
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return 'ssh'
  return null
}

// defaultKeyLabel names the login after the local user + host, gh-style, so
// the dashboard's approval page is legible ("cli-ada@laptop";
// "claude-code-ada@laptop" when a coding agent is driving).
function defaultKeyLabel(): string {
  let user = 'user'
  try {
    user = os.userInfo().username || 'user'
  } catch {
    // os.userInfo can throw when there's no passwd entry; keep the default.
  }
  let host = 'cli'
  try {
    host = os.hostname() || 'cli'
  } catch {
    // Keep the default hostname.
  }
  const prefix = agentContext() ?? 'cli'
  return `${prefix}-${user}@${host}`
}

// Handoff carries whatever the login path resolved: always a token, plus the
// key id and the dashboard origin when device login delivered them.
type Handoff = {
  token: string
  keyId?: string
  dashboardUrl?: string
}

type LoginOpts = {
  apiUrl?: string
  label?: string
  withToken?: string
  browser?: boolean
}

// runLogin is the shared action behind `orca auth login` and `orca login`:
// --with-token stores a key minted elsewhere (CI); otherwise the RFC 8628
// device login runs, which works everywhere, including inside coding agents.
async function runLogin(opts: LoginOpts, cmd: Command): Promise<void> {
  const flags = globalFlags(cmd)
  const cfg = await loadConfig()
  const name = flags.context || cfg.currentContext || DEFAULT_CONTEXT
  const existing = cfg.contexts[name] ?? {}
  const mode = outputMode(flags)

  // --- server URL (flag > env > file > baked-in default)
  let apiUrl = opts.apiUrl || flags.apiUrl || process.env.ORCA_API_URL || existing.apiUrl
  // Upgrade the former baked-in default (raw Railway hostname) regardless of
  // where it came from. Custom/self-hosted API URLs are left alone.
  if (apiUrl === LEGACY_DEFAULT_API_URL && DEFAULT_API_URL) apiUrl = DEFAULT_API_URL
  let apiUrlDefaulted = false
  if (!apiUrl && DEFAULT_API_URL) {
    apiUrl = DEFAULT_API_URL
    apiUrlDefaulted = true
  }
  if (!apiUrl) throw new CliError('no API URL; pass --api-url or set ORCA_API_URL', ExitCode.Usage)
  apiUrl = normalizeUrl(apiUrl, 'API URL')
  if (apiUrlDefaulted) {
    console.error(
      hintText(`Using the default Orca production API (${apiUrl}). Pass --api-url for self-hosted or local.`),
    )
  }

  const handoff: Handoff = opts.withToken
    ? { token: opts.withToken }
    : await deviceLogin({
        apiUrl,
        label: (opts.label && opts.label.trim()) || defaultKeyLabel(),
        mode,
        open: opts.browser !== false && interactive() && agentContext() === null,
      })

  // --- shared tail: validate, check with the server, persist, report ------
  const token = handoff.token.trim()
  if (!token) throw new CliError('empty API key', ExitCode.Usage)
  if (!token.startsWith('orca_sk_')) {
    console.error(hintText('warning: key does not look like an Orca API key (expected orca_sk_ prefix)'))
  }
  const who = await whoamiFor(apiUrl, token, name)

  const ctxOut: ContextConfig = { ...existing, apiUrl, apiKey: token }
  if (handoff.dashboardUrl) ctxOut.dashboardUrl = handoff.dashboardUrl
  if (handoff.keyId) ctxOut.keyId = handoff.keyId
  else delete ctxOut.keyId
  cfg.contexts[name] = ctxOut
  cfg.currentContext = name
  const file = await saveConfig(cfg)

  if (mode === 'json') {
    printJson({
      context: name,
      apiUrl,
      apiKey: maskKey(token),
      tenant: who.tenant,
      role: who.role,
      keyId: handoff.keyId ?? null,
      stored: file,
    })
    return
  }
  if (mode === 'plain') {
    console.log('Logged in to Orca.')
    return
  }
  console.log(`${accentVerb('Logged in')} to Orca as ${who.role} of ${who.tenant}.`)
}

// deviceLogin runs the RFC 8628 device-code flow against the server. Output
// is deliberately plain and agent-relayable: a coding agent driving this
// command copies the code and URL to its user verbatim. Human-facing lines go
// to stderr; in --json mode a single NDJSON event with the code and URLs goes
// to stdout first (the final login object follows from the shared tail).
async function deviceLogin(args: {
  apiUrl: string
  label: string
  mode: 'json' | 'plain' | 'ink'
  open: boolean
}): Promise<Handoff> {
  const grant = await requestDeviceCode(args.apiUrl, args.label)
  announceDeviceCode(grant, args.mode)
  if (args.open) openBrowser(grant.verification_uri_complete)
  const tok = await pollDeviceToken(args.apiUrl, grant)
  // The verification page is the dashboard's, so its origin is where this
  // server's kit pages live too.
  let dashboardUrl: string | undefined
  try {
    dashboardUrl = new URL(grant.verification_uri).origin
  } catch {
    dashboardUrl = undefined
  }
  return { token: tok.access_token, keyId: tok.key_id, dashboardUrl }
}

function announceDeviceCode(grant: DeviceCodeResponse, mode: 'json' | 'plain' | 'ink'): void {
  if (mode === 'json') {
    // One NDJSON line so scripted callers can surface the code immediately
    // while the process keeps polling.
    process.stdout.write(
      JSON.stringify({
        event: 'device_code',
        userCode: grant.user_code,
        verificationUri: grant.verification_uri,
        verificationUriComplete: grant.verification_uri_complete,
        expiresIn: grant.expires_in,
        interval: grant.interval,
      }) + '\n',
    )
  }
  const minutes = Math.round((grant.expires_in || 600) / 60)
  console.error(`First, copy your one-time code: ${grant.user_code}`)
  console.error(`Then open: ${grant.verification_uri_complete}`)
  console.error(hintText(`Waiting for approval... (expires in ${minutes} minutes, Ctrl-C to cancel)`))
}

// addLoginOptions keeps the two registrations of the login command
// byte-identical in their option surface.
function addLoginOptions(cmd: Command): Command {
  return cmd
    .option('--api-url <url>', 'Orca server base URL')
    .option('--label <label>', 'label for this login, shown on the approval page')
    .option('--with-token <token>', 'API key; skips the login flow entirely (for CI)')
    .option('--no-browser', 'print the code and URL without opening a browser')
}

// runWhoami backs `orca whoami` and `orca auth whoami`: who does the stored
// credential act as, according to the server.
async function runWhoami(_opts: Record<string, never>, cmd: Command): Promise<void> {
  const flags = globalFlags(cmd)
  const ctx = await resolveContext(flags)
  const mode = outputMode(flags)
  if (!ctx.apiUrl || !ctx.apiKey) {
    const missing = !ctx.apiUrl ? 'API URL' : 'API key'
    throw new CliError(`context "${ctx.name}" has no ${missing}`, ExitCode.Auth, ['Run: orca auth login'])
  }
  const apiUrl = ctx.apiUrl.replace(/\/+$/, '')
  const who = await whoamiFor(apiUrl, ctx.apiKey, ctx.name)

  if (mode === 'json') {
    printJson({
      context: ctx.name,
      apiUrl,
      apiKey: maskKey(ctx.apiKey),
      tenant: who.tenant,
      actor: who.actor,
      role: who.role,
      agent: who.agent,
    })
    return
  }
  if (mode === 'plain') {
    console.log(`Context:  ${ctx.name}`)
    console.log(`API URL:  ${apiUrl}`)
    console.log(`Tenant:   ${who.tenant}`)
    console.log(`Actor:    ${who.actor}`)
    console.log(`Role:     ${who.role}`)
    if (who.agent) console.log(`Agent:    ${who.agent}`)
    return
  }
  const { Panel, Field } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title="WHOAMI" subtitle={ctx.name}>
      <Field label="api url" value={apiUrl} />
      <Field label="tenant" value={who.tenant} />
      <Field label="actor" value={who.actor} />
      <Field label="role" value={who.role} />
      {who.agent ? <Field label="agent" value={who.agent} /> : null}
      <Field label="status" value="valid" valueColor={theme.accent} />
    </Panel>,
  )
}

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('authenticate orca with the platform')

  addLoginOptions(
    auth.command('login').description('sign the CLI in with a one-time code approved in the dashboard'),
  ).action(runLogin)

  // Top-level alias: `orca login` is what every agent-facing doc teaches.
  addLoginOptions(program.command('login').description('sign the CLI in (alias for auth login)')).action(
    runLogin,
  )

  auth.command('whoami').description('show which tenant and role the stored key acts as').action(runWhoami)
  program.command('whoami').description('show which tenant and role the stored key acts as').action(runWhoami)

  auth
    .command('status')
    .description('show the active context and whether its key works')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const ctx = await resolveContext(flags)
      const mode = outputMode(flags)

      if (!ctx.apiUrl || !ctx.apiKey) {
        const missing = !ctx.apiUrl ? 'API URL' : 'API key'
        throw new CliError(`context "${ctx.name}" has no ${missing}`, ExitCode.Auth, ['Run: orca auth login'])
      }
      const apiUrl = ctx.apiUrl.replace(/\/+$/, '')
      const who = await whoamiFor(apiUrl, ctx.apiKey, ctx.name)

      // "(default)" marks a value that came from the baked-in production
      // default rather than a flag, env var, or the config file.
      const mark = (field: DefaultableField, value: string): string =>
        ctx.defaulted.has(field) ? `${value} (default)` : value

      if (mode === 'json') {
        printJson({
          context: ctx.name,
          apiUrl,
          dashboardUrl: ctx.dashboardUrl ?? null,
          apiKey: maskKey(ctx.apiKey),
          role: who.role,
          defaults: [...ctx.defaulted],
          valid: true,
        })
        return
      }
      if (mode === 'plain') {
        console.log(`Context:  ${ctx.name}`)
        console.log(`API URL:  ${mark('apiUrl', apiUrl)}`)
        console.log(`Dashboard: ${ctx.dashboardUrl ? mark('dashboardUrl', ctx.dashboardUrl) : '-'}`)
        console.log(`API key:  ${maskKey(ctx.apiKey)} (valid, ${who.role})`)
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="AUTH" subtitle={ctx.name}>
          <Field label="api url" value={mark('apiUrl', apiUrl)} />
          <Field label="dashboard" value={ctx.dashboardUrl ? mark('dashboardUrl', ctx.dashboardUrl) : '-'} />
          <Field label="api key" value={maskKey(ctx.apiKey)} />
          <Field label="role" value={who.role} />
          <Field label="status" value="valid" valueColor={theme.accent} />
        </Panel>,
      )
    })

  auth
    .command('logout')
    .description('remove the stored API key for a context')
    .option('--revoke', 'revoke the key on the server before clearing it locally')
    .option('--yes', 'skip the confirmation prompt for --revoke')
    .action(async (opts: { revoke?: boolean; yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const cfg = await loadConfig()
      const name = flags.context || cfg.currentContext || DEFAULT_CONTEXT
      const ctx = cfg.contexts[name]
      if (!ctx?.apiKey) {
        console.log(hintText(`No API key stored for context "${name}".`))
        return
      }

      if (opts.revoke) {
        // Revoke is destructive: it invalidates the key on the server. Confirm
        // in an interactive TTY unless --yes bypasses it. Non-TTY skips the
        // prompt so scripts revoke, then clear locally. A decline leaves both
        // the server key and the local key untouched.
        if (!opts.yes && interactive()) {
          if (!(await confirmDestructive(`Revoke key for context "${name}" on the server? It stops working everywhere.`))) {
            console.error(hintText('Aborted.'))
            return
          }
        }
        if (ctx.keyId && ctx.apiUrl) {
          const client = new ApiClient({ apiUrl: ctx.apiUrl, apiKey: ctx.apiKey, contextName: name })
          try {
            await client.revokeKey(ctx.keyId)
            console.log(`${accentVerb('Revoked')} key ${ctx.keyId} on the server.`)
          } catch {
            // Best-effort: a 401 (already revoked), 404 (already gone), or
            // unreachable server must not strand the local key. Warn and
            // clear anyway so the user is never stuck logged in locally.
            console.error(hintText(`warning: could not revoke ${ctx.keyId} on the server; clearing locally anyway`))
          }
        } else {
          console.error(hintText('warning: no server-side key id stored; clearing locally only'))
        }
      }

      delete ctx.apiKey
      delete ctx.keyId
      await saveConfig(cfg)
      console.log(`${accentVerb('Removed')} API key for context "${name}".`)
    })
}
