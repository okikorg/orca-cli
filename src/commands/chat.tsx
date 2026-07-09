import type { Command } from 'commander'

import { ApiClient } from '../lib/api.js'
import { resolveContext, type ResolvedContext } from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import {
  GatewayClient,
  mapGatewayError,
  type ChatEvent,
  type ChatTurnResult,
  type GatewayFrame,
} from '../lib/gateway.js'
import { interactive } from '../lib/output.js'
import { ansi } from '../ui/theme.js'
import type { SendTurn } from '../ui/Chat.js'
import { fetchAll, globalFlags } from './shared.js'

type ChatOpts = {
  key?: string
  tenant?: string
  conversation?: string
  endUser?: string
}

// readStdin drains piped input for the single-shot "echo hi | orca chat" path.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// emitNdjson writes one line per SSE frame for --json, skipping heartbeat
// comment frames. Shape: { event, data } with data parsed from the frame.
function emitNdjson(frame: GatewayFrame): void {
  if (frame.data === '' && frame.comment !== null) return
  let data: unknown = frame.data
  try {
    data = JSON.parse(frame.data)
  } catch {
    /* leave as the raw string */
  }
  process.stdout.write(JSON.stringify({ event: frame.event, data }) + '\n')
}

// noteTool prints a subtle tool notice to stderr in single-shot plain mode,
// keeping stdout pure answer text. Silent when stderr is not a terminal.
function noteTool(event: Extract<ChatEvent, { type: 'tool' }>): void {
  if (!process.stderr.isTTY) return
  const color = process.env.NO_COLOR ? '' : ansi.subtle
  const reset = process.env.NO_COLOR ? '' : ansi.reset
  process.stderr.write(`${color}tool ${event.name} ${event.status}${reset}\n`)
}

async function runSingleShot(
  client: GatewayClient,
  agent: string,
  message: string,
  opts: ChatOpts,
  json: boolean,
): Promise<void> {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)
  try {
    let wroteText = false
    let result: ChatTurnResult
    try {
      result = await client.streamChat(message, {
        conversationId: opts.conversation,
        endUserId: opts.endUser,
        signal: controller.signal,
        onFrame: json ? emitNdjson : undefined,
        onEvent: json
          ? undefined
          : (event) => {
              if (event.type === 'delta') {
                process.stdout.write(event.text)
                wroteText = true
              } else if (event.type === 'tool') {
                noteTool(event)
              }
            },
      })
    } catch (err) {
      throw mapGatewayError(err, { gatewayUrl: client.gatewayUrl, agent })
    }

    if (controller.signal.aborted || result.terminated === 'aborted') {
      // A partial line may be on stdout; terminate it so the shell prompt is clean.
      if (!json && wroteText) process.stdout.write('\n')
      throw new CliError('interrupted', ExitCode.Interrupt)
    }

    if (!json) {
      // The done event carries the full terminal text; fall back to it if no
      // deltas were delivered, then emit exactly one trailing newline.
      if (!wroteText && result.message) process.stdout.write(result.message)
      process.stdout.write('\n')
    }

    // Emit the conversation id to stderr so scripts can capture and resume it
    // (stdout is reserved for the answer / ndjson).
    if (result.conversationId) process.stderr.write(`conversation ${result.conversationId}\n`)

    if (result.terminated === 'error') {
      throw new CliError(result.message || result.errorCode || 'upstream error', ExitCode.Failure)
    }
    if (result.terminated === 'dropped') {
      throw new CliError('stream closed before a terminal done/error event', ExitCode.Failure)
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

async function runRepl(client: GatewayClient, agent: string, opts: ChatOpts): Promise<void> {
  const { render } = await import('ink')
  const { Chat } = await import('../ui/Chat.js')

  // The REPL never rejects on a gateway error: HTTP-level failures are mapped
  // to a { terminated: 'error' } result so a bad turn keeps the session alive.
  const send: SendTurn = (message, handlers, conversationId) =>
    client
      .streamChat(message, {
        conversationId,
        endUserId: opts.endUser,
        signal: handlers.signal,
        onEvent: handlers.onEvent,
      })
      .catch((err: unknown) => {
        const mapped = mapGatewayError(err, { gatewayUrl: client.gatewayUrl, agent })
        return { terminated: 'error' as const, message: mapped.message }
      })

  const instance = render(
    <Chat agentLabel={agent} initialConversationId={opts.conversation} send={send} onExit={() => {}} />,
    { exitOnCtrlC: false },
  )
  await instance.waitUntilExit()
}

// pickPublishedAgent opens the generic Picker over the tenant's published
// agents so an interactive `orca chat` with no agent arg still resolves one.
// It only runs in an interactive TTY with a conductor key configured; every
// non-TTY path keeps the byte-identical missing-arg usage error. Rows show the
// profile name with the published slug as subtle detail; the chosen value is
// the profile name, which the tenant-resolution block below already accepts
// (falling back to a slug match).
async function pickPublishedAgent(resolved: ResolvedContext): Promise<string> {
  if (!resolved.apiUrl || !resolved.apiKey) {
    throw new CliError('agent name required', ExitCode.Usage, [
      'Usage: orca chat <agent> "message"',
      'Configure a conductor context (orca auth login) to pick from published agents.',
    ])
  }
  const api = new ApiClient({
    apiUrl: resolved.apiUrl,
    apiKey: resolved.apiKey,
    contextName: resolved.name,
  })
  const page = await fetchAll((params) => api.listPublishedAgents(params))
  if (page.items.length === 0) {
    throw new CliError('no published agents to chat with', ExitCode.Usage, [
      'Publish one first: orca agents publish <agent>',
    ])
  }
  const { pickOne } = await import('../ui/AgentPicker.js')
  // pickOne takes plain names; the profile name is what tenant resolution keys
  // off, and it is the human-facing label anyway.
  return pickOne('Select a published agent', page.items.map((p) => p.profileName))
}

export function registerChat(program: Command): void {
  program
    .command('chat [agent] [prompt...]')
    .description('chat with a published agent through the public gateway (always streams over SSE)')
    .option('--key <chat-key>', 'published-agent chat key (or env ORCA_CHAT_KEY)')
    .option('--tenant <slug>', 'tenant the agent was published under (or env ORCA_TENANT)')
    .option('--conversation <id>', 'resume a prior conversation (single-shot)')
    .option('--end-user <id>', 'metadata.end_user_id passed to the gateway')
    .action(async (agentArg: string | undefined, promptParts: string[], opts: ChatOpts, cmd: Command) => {
      const flags = globalFlags(cmd)
      const resolved = await resolveContext(flags)

      // An omitted agent arg opens the picker only in an interactive TTY; the
      // non-TTY / --json / piped paths keep the original usage error so scripts
      // and machine contracts are untouched.
      let agent = agentArg
      if (!agent) {
        const piped = !process.stdin.isTTY
        if (Boolean(flags.json) || piped || !interactive()) {
          throw new CliError('agent name required', ExitCode.Usage, [
            'Usage: orca chat <agent> "message"',
            'Or pipe stdin: echo hi | orca chat <agent>',
          ])
        }
        agent = await pickPublishedAgent(resolved)
      }

      const gatewayUrl = resolved.gatewayUrl
      if (!gatewayUrl) {
        throw new CliError('no chat gateway URL configured', ExitCode.Usage, [
          'Set ORCA_GATEWAY_URL, or add gatewayUrl to your context.',
        ])
      }

      // Never echoed back; only used to build the Authorization header.
      const chatKey = opts.key ?? process.env.ORCA_CHAT_KEY
      if (!chatKey) {
        throw new CliError('no chat key for the published agent', ExitCode.Auth, [
          `Mint one with: orca agents keys create ${agent}`,
          'Then pass --key <chat-key> or set ORCA_CHAT_KEY.',
        ])
      }

      // Tenant precedence: flag > env > conductor lookup. The lookup also
      // corrects the gateway path segment when the published slug differs
      // from the profile name.
      let tenant = opts.tenant ?? process.env.ORCA_TENANT
      let slug = agent
      if (!tenant && resolved.apiUrl && resolved.apiKey) {
        const api = new ApiClient({
          apiUrl: resolved.apiUrl,
          apiKey: resolved.apiKey,
          contextName: resolved.name,
        })
        try {
          const pub = await api.getPublishedAgent(agent)
          tenant = pub.tenantId
          slug = pub.slug
        } catch {
          // Not published under that profile name; the arg may be a slug. Page
          // through the whole published set (the server caps a single request
          // at 200) so a slug past the first page still resolves.
          try {
            const page = await fetchAll((params) => api.listPublishedAgents(params))
            const hit = page.items.find((p) => p.slug === agent)
            if (hit) {
              tenant = hit.tenantId
              slug = hit.slug
            }
          } catch {
            // Conductor unreachable or key rejected; fall through to the
            // explicit-tenant error below.
          }
        }
      }
      if (!tenant) {
        throw new CliError('no tenant for the published agent', ExitCode.Usage, [
          `"${agent}" does not match a published agent in your org (check: orca agents list).`,
          `Publish it first: orca agents publish ${agent}`,
          'Or pass --tenant <org_...> / set ORCA_TENANT if it lives in another org.',
        ])
      }

      const client = new GatewayClient({ gatewayUrl, tenant, agent: slug, chatKey })

      const prompt = promptParts.join(' ').trim()
      const piped = !process.stdin.isTTY
      const json = Boolean(flags.json)
      const wantRepl = !json && !prompt && !piped && interactive()

      if (wantRepl) {
        await runRepl(client, agent, opts)
        return
      }

      let message = prompt
      if (!message && piped) message = (await readStdin()).trim()
      if (!message) {
        throw new CliError('no prompt given', ExitCode.Usage, [
          'Usage: orca chat <agent> "message"',
          'Or pipe stdin: echo hi | orca chat <agent>',
        ])
      }

      await runSingleShot(client, agent, message, opts, json)
    })
}
