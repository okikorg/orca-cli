import { randomBytes } from 'node:crypto'
import os from 'node:os'

import type { Command } from 'commander'

import { ApiClient, ApiError, mapApiError } from '../lib/api.js'
import {
  DEFAULT_CONTEXT,
  loadConfig,
  maskKey,
  resolveContext,
  saveConfig,
  type ContextConfig,
  type DefaultableField,
} from '../lib/config.js'
import {
  DEFAULT_API_URL,
  DEFAULT_DASHBOARD_URL,
  LEGACY_DEFAULT_DASHBOARD_URL,
} from '../lib/defaults.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { listenForKeyPaste } from '../lib/key-listener.js'
import {
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCodeResponse,
} from '../lib/device-flow.js'
import {
  LoginTimeoutError,
  openBrowser,
  startLoginServer,
  type CallbackPayload,
} from '../lib/login-server.js'
import { interactive, outputMode, printJson, renderStatic } from '../lib/output.js'
import { accentVerb, glyphs, hintText } from '../ui/theme.js'
import { globalFlags } from './shared.js'

// confirmDestructive mounts the shared Confirm component for a y/N gate in
// interactive TTY mode (single keypress; Enter declines, so the safe answer is
// the default). Ctrl-C unmounts without a decision and is treated as a decline.
// Callers gate this on interactive() so the non-TTY machine contract (revoke
// proceeds without a prompt) stays byte-identical. Kept local per command
// because the shared prompts module is owned by another wave; the mount pattern
// mirrors pickOne/promptText.
async function confirmDestructive(message: string): Promise<boolean> {
  const { render } = await import('ink')
  const { Confirm } = await import('../ui/Confirm.js')
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      instance.unmount()
      resolve(v)
    }
    const instance = render(<Confirm message={message} onDecision={finish} />, { exitOnCtrlC: true })
    void instance.waitUntilExit().then(() => finish(false))
  })
}

// verifyKey probes an endpoint every role (including Observer) can read.
// /api/api-keys is deliberately not used: it can 403 for restricted roles.
async function verifyKey(apiUrl: string, apiKey: string, contextName: string): Promise<void> {
  const client = new ApiClient({ apiUrl, apiKey, contextName })
  try {
    await client.listProfiles({ limit: 1 })
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
// context) driving this login, so the flow auto-selects device login and the
// key label says who minted it. Returns a label prefix, or null when this
// looks like a human at a terminal.
function agentContext(): string | null {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return 'claude-code'
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  if (process.env.CI) return 'ci'
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return 'ssh'
  return null
}

// defaultKeyLabel names the key after the local user + host, gh-style, so the
// dashboard's key list is legible ("cli-ada@laptop"; "claude-code-ada@laptop"
// when a coding agent is driving).
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

// promptForKey masks a pasted key, reused by the --no-browser and timeout
// fallbacks. Callers must have already checked interactive().
async function promptForKey(): Promise<string> {
  const { promptText } = await import('../ui/PromptInput.js')
  return promptText({ label: 'Paste the API key', placeholder: 'ao_...', mask: true })
}

// Handoff carries whatever the login path resolved: always a token, plus the
// key metadata when the browser callback delivered it.
type Handoff = {
  token: string
  keyId?: string
  role?: string
  orgSlug?: string | null
}

// runLogin is the shared action behind `orca auth login` and `orca login`.
//
// Flow selection, in order:
//   --with-token          no flow at all (CI/manual)
//   --headless / --browserless / --no-browser
//                         device-code flow, explicitly
//   no TTY, or a coding-agent / CI / SSH environment
//                         device-code flow, automatically (this is the
//                         "orca login just works inside Claude Code" path)
//   otherwise             browser + loopback (the legacy interactive flow)
async function runLogin(opts: LoginOpts, cmd: Command): Promise<void> {
  const flags = globalFlags(cmd)
  const cfg = await loadConfig()
  const name = flags.context || cfg.currentContext || DEFAULT_CONTEXT
  const existing = cfg.contexts[name] ?? {}
  const mode = outputMode(flags)

  // --- conductor API URL (flag > env > file > baked-in default > prompt)
  let apiUrl = opts.apiUrl || flags.apiUrl || process.env.ORCA_API_URL || existing.apiUrl
  let apiUrlDefaulted = false
  if (!apiUrl && DEFAULT_API_URL) {
    apiUrl = DEFAULT_API_URL
    apiUrlDefaulted = true
  }
  if (!apiUrl) {
    if (!interactive()) {
      throw new CliError('no API URL; pass --api-url or set ORCA_API_URL', ExitCode.Usage)
    }
    const { promptText } = await import('../ui/PromptInput.js')
    apiUrl = await promptText({
      label: 'Conductor API URL',
      initial: 'http://localhost:8080',
    })
  }
  apiUrl = normalizeUrl(apiUrl, 'API URL')
  if (apiUrlDefaulted) {
    console.error(
      hintText(`Using the default Orca production API (${apiUrl}). Pass --api-url for self-hosted or local.`),
    )
  }

  // --- dashboard URL (flag > env > file > baked-in default). Required only
  //     for the browser loopback flow; the device flow gets its verification
  //     URL from the conductor, and --with-token persists it if provided. ----
  let dashboardUrl =
    opts.dashboardUrl || process.env.ORCA_DASHBOARD_URL || existing.dashboardUrl || DEFAULT_DASHBOARD_URL || undefined
  if (dashboardUrl) {
    dashboardUrl = normalizeUrl(dashboardUrl, 'dashboard URL')
    // Upgrade the former first-party default regardless of whether it
    // came from a saved context, an old shell export, or an explicit
    // invocation. Custom/self-hosted dashboard URLs are left alone.
    if (dashboardUrl === LEGACY_DEFAULT_DASHBOARD_URL && DEFAULT_DASHBOARD_URL) {
      dashboardUrl = DEFAULT_DASHBOARD_URL
    }
  }

  let handoff: Handoff

  if (opts.withToken) {
    // Manual/CI path: token supplied directly, no browser, no prompt.
    handoff = { token: opts.withToken }
  } else {
    const label = (opts.label && opts.label.trim()) || defaultKeyLabel()
    const wantDevice =
      opts.headless === true ||
      opts.browserless === true ||
      opts.browser === false ||
      !interactive() ||
      agentContext() !== null
    if (wantDevice) {
      handoff = await deviceLogin({ apiUrl, label, mode })
    } else {
      const state = randomBytes(32).toString('hex')
      if (!dashboardUrl) {
        throw new CliError('no dashboard URL configured', ExitCode.Usage, [
          'Pass --dashboard-url <url> or set ORCA_DASHBOARD_URL.',
        ])
      }
      handoff = await browserLogin({ dashboardUrl, state, label })
    }
  }

  // --- shared tail: validate, probe, persist, report -------------------
  const token = handoff.token.trim()
  if (!token) throw new CliError('empty API key', ExitCode.Usage)
  if (!token.startsWith('ao_')) {
    console.error(hintText('warning: key does not look like a tenant API key (expected ao_ prefix)'))
  }

  await verifyKey(apiUrl, token, name)

  const ctxOut: ContextConfig = { ...existing, apiUrl, apiKey: token }
  if (dashboardUrl) ctxOut.dashboardUrl = dashboardUrl
  if (opts.gatewayUrl) ctxOut.gatewayUrl = opts.gatewayUrl.trim().replace(/\/+$/, '')
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
      role: handoff.role ?? null,
      org: handoff.orgSlug ?? null,
      keyId: handoff.keyId ?? null,
      stored: file,
    })
    return
  }
  if (mode === 'plain') {
    console.log('Logged in to Orca.')
    return
  }
  console.log(`${accentVerb('Logged in')} to Orca.`)
}

// deviceLogin runs the RFC 8628 device-code flow against the conductor.
// Output is deliberately plain and agent-relayable: a coding agent driving
// this command copies the code and URL to its user verbatim. Human-facing
// lines go to stderr; in --json mode a single NDJSON event with the code and
// URLs goes to stdout first (the final login object follows from the shared
// tail, matching the loopback flow's JSON contract).
async function deviceLogin(args: {
  apiUrl: string
  label: string
  mode: 'json' | 'plain' | 'ink'
}): Promise<Handoff> {
  const grant = await requestDeviceCode(args.apiUrl, args.label)
  announceDeviceCode(grant, args.mode)
  const tok = await pollDeviceToken(args.apiUrl, grant)
  return {
    token: tok.access_token,
    keyId: tok.key_id,
    role: tok.role,
    orgSlug: tok.org_slug ?? null,
  }
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
  const minutes = Math.round((grant.expires_in || 900) / 60)
  console.error(`First, copy your one-time code: ${grant.user_code}`)
  console.error(`Then open: ${grant.verification_uri_complete}`)
  console.error(hintText(`Waiting for approval... (expires in ${minutes} minutes, Ctrl-C to cancel)`))
}

// LoginOpts is shared by `orca auth login` and the `orca login` alias.
type LoginOpts = {
  apiUrl?: string
  dashboardUrl?: string
  gatewayUrl?: string
  label?: string
  withToken?: string
  browser?: boolean
  headless?: boolean
  browserless?: boolean
}

// addLoginOptions keeps the two registrations of the login command
// byte-identical in their option surface.
function addLoginOptions(cmd: Command): Command {
  return cmd
    .option('--api-url <url>', 'conductor API base URL')
    .option('--dashboard-url <url>', 'Orca dashboard base URL (or set ORCA_DASHBOARD_URL)')
    .option('--gateway-url <url>', 'public chat gateway base URL')
    .option('--label <label>', 'label for the minted key, shown in the dashboard')
    .option('--with-token <token>', 'API key; skips the login flow entirely (for CI)')
    .option('--headless', 'device-code flow: print a code + URL, approve on any device')
    .option('--browserless', 'alias for --headless')
    .option('--no-browser', 'same as --headless (kept for compatibility)')
}

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('authenticate orca with the platform')

  addLoginOptions(
    auth
      .command('login')
      .description('sign the CLI in (browser flow, or a device code when headless)'),
  ).action(runLogin)

  // Top-level alias: `orca login` is what every agent-facing doc teaches.
  addLoginOptions(
    program
      .command('login')
      .description('sign the CLI in (alias for auth login)'),
  ).action(runLogin)

  // `orca whoami`: who does the stored credential act as, according to the
  // SERVER (tenant, role, credential kind, key id). Degrades to a local
  // context summary against conductors that predate GET /api/whoami.
  program
    .command('whoami')
    .description('show which tenant and role the stored key acts as')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const ctx = await resolveContext(flags)
      const mode = outputMode(flags)
      if (!ctx.apiUrl || !ctx.apiKey) {
        const missing = !ctx.apiUrl ? 'API URL' : 'API key'
        throw new CliError(`context "${ctx.name}" has no ${missing}`, ExitCode.Auth, [
          'Run: orca login',
        ])
      }
      const apiUrl = ctx.apiUrl.replace(/\/+$/, '')
      const client = new ApiClient({ apiUrl, apiKey: ctx.apiKey, contextName: ctx.name })

      let who: Awaited<ReturnType<ApiClient['whoami']>> | null = null
      try {
        who = await client.whoami()
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // Old conductor: prove the key still works, then report locally.
          await verifyKey(apiUrl, ctx.apiKey, ctx.name)
        } else {
          throw mapApiError(err, { contextName: ctx.name, apiUrl })
        }
      }

      if (mode === 'json') {
        printJson({
          context: ctx.name,
          apiUrl,
          apiKey: maskKey(ctx.apiKey),
          tenantId: who?.tenantId ?? null,
          tenantName: who?.tenantName ?? null,
          role: who?.role ?? null,
          authKind: who?.authKind ?? null,
          keyId: who?.keyId ?? ctx.keyId ?? null,
          serverSupportsWhoami: who !== null,
        })
        return
      }
      if (mode === 'plain') {
        console.log(`Context:  ${ctx.name}`)
        console.log(`API URL:  ${apiUrl}`)
        if (who) {
          console.log(`Tenant:   ${who.tenantName ? `${who.tenantName} (${who.tenantId})` : who.tenantId}`)
          console.log(`Role:     ${who.role ?? '-'}`)
          console.log(`Key:      ${who.keyId ?? '-'} (${who.authKind})`)
        } else {
          console.log(`API key:  ${maskKey(ctx.apiKey)} (valid; server predates /api/whoami)`)
        }
        return
      }
      const { Panel, Field } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="WHOAMI" subtitle={ctx.name}>
          <Field label="api url" value={apiUrl} />
          <Field
            label="tenant"
            value={who ? (who.tenantName ? `${who.tenantName} (${who.tenantId})` : who.tenantId) : 'unknown (server predates /api/whoami)'}
          />
          <Field label="role" value={who?.role ?? '-'} />
          <Field label="key" value={who?.keyId ?? ctx.keyId ?? maskKey(ctx.apiKey)} />
          <Field label="status" value="valid" valueColor={theme.accent} />
        </Panel>,
      )
    })

  auth
    .command('status')
    .description('show the active context and whether its key works')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const ctx = await resolveContext(flags)
      const mode = outputMode(flags)

      if (!ctx.apiUrl || !ctx.apiKey) {
        const missing = !ctx.apiUrl ? 'API URL' : 'API key'
        throw new CliError(`context "${ctx.name}" has no ${missing}`, ExitCode.Auth, [
          'Run: orca auth login',
        ])
      }
      const apiUrl = ctx.apiUrl.replace(/\/+$/, '')
      await verifyKey(apiUrl, ctx.apiKey, ctx.name)

      // "(default)" marks a value that came from the baked-in production
      // default rather than a flag, env var, or the config file.
      const mark = (field: DefaultableField, value: string): string =>
        ctx.defaulted.has(field) ? `${value} (default)` : value

      if (mode === 'json') {
        printJson({
          context: ctx.name,
          apiUrl,
          gatewayUrl: ctx.gatewayUrl ?? null,
          dashboardUrl: ctx.dashboardUrl ?? null,
          apiKey: maskKey(ctx.apiKey),
          defaults: [...ctx.defaulted],
          valid: true,
        })
        return
      }
      if (mode === 'plain') {
        console.log(`Context:  ${ctx.name}`)
        console.log(`API URL:  ${mark('apiUrl', apiUrl)}`)
        console.log(`Gateway:  ${ctx.gatewayUrl ? mark('gatewayUrl', ctx.gatewayUrl) : '-'}`)
        console.log(`Dashboard: ${ctx.dashboardUrl ? mark('dashboardUrl', ctx.dashboardUrl) : '-'}`)
        console.log(`API key:  ${maskKey(ctx.apiKey)} (valid)`)
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="AUTH" subtitle={ctx.name}>
          <Field label="api url" value={mark('apiUrl', apiUrl)} />
          <Field label="gateway" value={ctx.gatewayUrl ? mark('gatewayUrl', ctx.gatewayUrl) : '-'} />
          <Field label="dashboard" value={ctx.dashboardUrl ? mark('dashboardUrl', ctx.dashboardUrl) : '-'} />
          <Field label="api key" value={maskKey(ctx.apiKey)} />
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
        // in an interactive TTY unless --yes bypasses it. Non-TTY (interactive()
        // false) skips the prompt entirely so the machine contract — revoke
        // proceeds, then clears locally — stays byte-identical to today. A
        // decline leaves both the server key and the local key untouched.
        if (!opts.yes && interactive()) {
          if (!(await confirmDestructive(`Revoke key for context "${name}" on the server? It stops working everywhere.`))) {
            console.error(hintText('Aborted.'))
            return
          }
        }
        if (ctx.keyId && ctx.apiUrl) {
          const client = new ApiClient({
            apiUrl: ctx.apiUrl,
            apiKey: ctx.apiKey,
            contextName: name,
          })
          try {
            await client.revokeControlPlaneKey(ctx.keyId)
            console.log(`${accentVerb('Revoked')} key ${ctx.keyId} on the server.`)
          } catch {
            // Best-effort: a 401 (already-rotated pepper), 404 (already gone),
            // or unreachable server must not strand the local key. Warn and
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

// browserLogin runs the localhost-callback flow: bind a port, open the
// dashboard, and wait for the minted key. While waiting it also accepts a
// pasted key directly (for browsers that cannot reach the loopback server
// and fall back to showing the key on screen). On timeout it falls back to
// a masked paste prompt; on Ctrl-C it exits 130.
async function browserLogin(args: {
  dashboardUrl: string
  state: string
  label: string
}): Promise<Handoff> {
  const server = await startLoginServer({
    state: args.state,
    allowOrigin: new URL(args.dashboardUrl).origin,
  })
  const authUrl = `${args.dashboardUrl}/cli-auth?state=${args.state}&port=${server.port}&label=${encodeURIComponent(args.label)}`

  openBrowser(authUrl)
  console.error(hintText('Opening Orca in your browser...'))
  console.error(hintText('Waiting for authorization (Ctrl-C to cancel)...'))

  const onSigint = () => server.close()
  process.once('SIGINT', onSigint)

  // Race the loopback callback against a direct paste. The callback promise
  // maps its rejection into a value so that losing the race can never leave
  // an unhandled rejection behind.
  type Outcome =
    | { kind: 'callback'; payload: CallbackPayload }
    | { kind: 'pasted'; token: string }
    | { kind: 'failed'; err: unknown }
  const callbackOutcome: Promise<Outcome> = server.waitForCallback().then(
    (payload) => ({ kind: 'callback', payload }),
    (err: unknown) => ({ kind: 'failed', err }),
  )
  const listener = listenForKeyPaste({
    prompt: hintText(`${glyphs.pointer} Paste key if shown in browser: `),
    // Raw mode swallows Ctrl-C; closing the server routes it through the
    // same cancelled path as a real SIGINT.
    onCancel: () => server.close(),
  })
  const races: Array<Promise<Outcome>> = [callbackOutcome]
  if (listener) {
    races.push(listener.promise.then((token) => ({ kind: 'pasted', token })))
  }

  try {
    const outcome = await Promise.race(races)
    listener?.stop()
    if (outcome.kind === 'pasted') {
      return { token: outcome.token }
    }
    if (outcome.kind === 'callback') {
      return {
        token: outcome.payload.key,
        keyId: outcome.payload.keyId,
        role: outcome.payload.role,
        orgSlug: outcome.payload.orgSlug,
      }
    }
    throw outcome.err
  } catch (err) {
    listener?.stop()
    if (err instanceof LoginTimeoutError) {
      console.error(
        hintText('Timed out waiting for the browser. Paste the key shown in the dashboard instead.'),
      )
      return { token: await promptForKey() }
    }
    // LoginCancelledError (Ctrl-C) or anything else: surface as an interrupt.
    throw new CliError('login cancelled', ExitCode.Interrupt)
  } finally {
    listener?.stop()
    process.off('SIGINT', onSigint)
    server.close()
  }
}
