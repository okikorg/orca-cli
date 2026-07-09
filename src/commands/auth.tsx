import { randomBytes } from 'node:crypto'
import os from 'node:os'

import type { Command } from 'commander'

import { ApiClient, mapApiError } from '../lib/api.js'
import {
  DEFAULT_CONTEXT,
  loadConfig,
  maskKey,
  resolveContext,
  saveConfig,
  type ContextConfig,
  type DefaultableField,
} from '../lib/config.js'
import { DEFAULT_API_URL, DEFAULT_DASHBOARD_URL } from '../lib/defaults.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { listenForKeyPaste } from '../lib/key-listener.js'
import {
  LoginTimeoutError,
  openBrowser,
  startLoginServer,
  type CallbackPayload,
} from '../lib/login-server.js'
import { interactive, outputMode, printJson, renderStatic } from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
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

// defaultKeyLabel names the key after the local user + host, gh-style, so the
// dashboard's key list is legible ("cli-ada@laptop").
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
  return `cli-${user}@${host}`
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// describeRoleOrg builds the " as Admin in acme" suffix for the success line,
// omitting whichever piece the handoff didn't carry (the paste path has none).
function describeRoleOrg(role?: string, orgSlug?: string | null): string {
  const r = role ? ` as ${titleCase(role)}` : ''
  const o = orgSlug ? ` in ${orgSlug}` : ''
  return `${r}${o}`
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

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('authenticate orca with the platform')

  auth
    .command('login')
    .description('authorize the CLI in your browser and store the resulting key')
    .option('--api-url <url>', 'conductor API base URL')
    .option('--dashboard-url <url>', 'Orca dashboard base URL (or set ORCA_DASHBOARD_URL)')
    .option('--gateway-url <url>', 'public chat gateway base URL')
    .option('--label <label>', 'label for the minted key, shown in the dashboard')
    .option('--with-token <token>', 'API key; skips the browser flow (for CI)')
    .option('--no-browser', 'print the authorize URL instead of opening a browser')
    .action(
      async (
        opts: {
          apiUrl?: string
          dashboardUrl?: string
          gatewayUrl?: string
          label?: string
          withToken?: string
          browser?: boolean
        },
        cmd: Command,
      ) => {
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

        // --- dashboard URL (flag > env > file > baked-in default). Required
        //     only for the browser/paste flow; the --with-token path persists
        //     it if provided but does not require it. --------------------------
        let dashboardUrl =
          opts.dashboardUrl || process.env.ORCA_DASHBOARD_URL || existing.dashboardUrl || DEFAULT_DASHBOARD_URL || undefined
        if (dashboardUrl) dashboardUrl = normalizeUrl(dashboardUrl, 'dashboard URL')

        let handoff: Handoff

        if (opts.withToken) {
          // Manual/CI path: token supplied directly, no browser, no prompt.
          handoff = { token: opts.withToken }
        } else {
          // Browser/paste path is interactive-only; CI must use --with-token.
          if (!interactive()) {
            throw new CliError(
              'browser login needs an interactive terminal',
              ExitCode.Usage,
              ['Pass --with-token <key> for non-interactive or CI use.'],
            )
          }
          if (!dashboardUrl) {
            throw new CliError('no dashboard URL configured', ExitCode.Usage, [
              'Pass --dashboard-url <url> or set ORCA_DASHBOARD_URL.',
            ])
          }

          const label = (opts.label && opts.label.trim()) || defaultKeyLabel()
          const state = randomBytes(32).toString('hex')

          if (opts.browser === false) {
            // --no-browser: no port in the URL, so the dashboard reveals the
            // key for the user to paste back here.
            const authUrl = `${dashboardUrl}/cli-auth?state=${state}&label=${encodeURIComponent(label)}`
            console.error(hintText('Open this URL, authorize, then paste the key below:'))
            console.error(`  ${authUrl}`)
            handoff = { token: await promptForKey() }
          } else {
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

        const roleOrg = describeRoleOrg(handoff.role, handoff.orgSlug)
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
          console.log(`Logged in${roleOrg}. Context "${name}" -> ${apiUrl} (${maskKey(token)})`)
          console.error(`Key stored in ${file}`)
          return
        }
        console.log(
          `${accentVerb('Logged in')}${roleOrg}. Context "${name}" -> ${apiUrl} (${maskKey(token)})`,
        )
        console.error(hintText(`Key stored in ${file}`))
      },
    )

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
  console.error(hintText('Opening your browser to authorize Orca CLI...'))
  console.error(hintText(`If it does not open, visit:\n  ${authUrl}`))
  console.error(hintText('Waiting for the browser to authorize (Ctrl-C to cancel)...'))
  console.error(hintText('If the page shows you a key instead, paste it here and press Enter.'))

  // Live elapsed ticker so a stalled handshake never looks like a hang.
  // stderr only, TTY only, erased before any subsequent output.
  let ticker: ReturnType<typeof setInterval> | undefined
  const startedAt = Date.now()
  if (process.stderr.isTTY) {
    ticker = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000)
      process.stderr.write(`\r${hintText(`  waiting... ${s}s`)} `)
    }, 1000)
  }
  const clearTicker = () => {
    if (ticker) clearInterval(ticker)
    ticker = undefined
    if (process.stderr.isTTY) process.stderr.write('\r'.padEnd(24) + '\r')
  }

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
    onFirstInput: clearTicker,
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
    clearTicker()
    if (outcome.kind === 'pasted') {
      console.error(hintText('Key received.'))
      return { token: outcome.token }
    }
    if (outcome.kind === 'callback') {
      console.error(hintText('Browser authorization received.'))
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
    clearTicker()
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
    clearTicker()
    process.off('SIGINT', onSigint)
    server.close()
  }
}
