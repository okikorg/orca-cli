import type { Command } from 'commander'
import type OpenAI from 'openai'
import { APIError } from 'openai/error'
import type { AgentSessionEvent } from 'openai/resources/beta/agents/agents'

import { resolveAgentId } from '../lib/agents.js'
import { mapApiError, toPage } from '../lib/api.js'
import { creditOut, otherSide, pickerItems, preselect, refusedAtAdmission } from '../lib/models.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { stripControlSequences } from '../lib/markdown.js'
import { interactive } from '../lib/output.js'
import {
  addSessionCreateOptions,
  sessionCreateParams,
  streamTurn,
  type ChatEvent,
  type SessionCreateFlags,
} from '../lib/sessions.js'
import { ansi, glyphs, hintText } from '../ui/theme.js'
import type { SendTurn, Switcher } from '../ui/Chat.js'
import type { SwitchChoice } from '../ui/SwitchPrompt.js'
import { apiContext, fetchAll, globalFlags, withApi, type ApiContext } from './shared.js'

type ChatOpts = SessionCreateFlags & { session?: string }

// readStdin drains piped input for the single-shot "echo hi | orca chat" path.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// emitNdjson writes one line per raw session event for --json.
function emitNdjson(event: AgentSessionEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n')
}

// noteTool prints one concise start notice to stderr in single-shot plain mode.
// Successful completion is silent; a failed completion gets an explicit line.
function noteTool(event: Extract<ChatEvent, { type: 'tool' }>): void {
  if (!process.stderr.isTTY) return
  if (event.status === 'ok') return
  const raw = event.name ?? 'tool'
  const name = stripControlSequences(raw.split('__').at(-1) ?? raw)
  const color = process.env.NO_COLOR ? '' : ansi.subtle
  const reset = process.env.NO_COLOR ? '' : ansi.reset
  const status = event.status === 'error' ? ' failed' : ''
  process.stderr.write(`${color}${glyphs.treeLast} ${name}${status}${reset}\n`)
}

// openSession returns the session to talk to: the one --session names, or a
// new session of the agent, with the environment and vaults the flags ask
// for.
async function openSession(client: OpenAI, agentId: string | undefined, opts: ChatOpts): Promise<string> {
  if (opts.session) return opts.session
  const session = await client.beta.agents.sessions.create(sessionCreateParams(agentId as string, opts))
  return session.id
}

// What a continue after a switch sends, as the dashboard's Continue does:
// the next turn resumes the saved conversation.
const CONTINUE_MESSAGE = 'Continue'

// switcher loads the other side of who pays for a session and switches it.
// The REPL and the single-shot prompt share it.
function switcher(api: ApiContext): Switcher {
  return {
    load: async (sessionId) =>
      withApi(api, async (c) => {
        const current = await c.sessionModel(sessionId)
        const list = await c.models()
        const side = otherSide(list, current.payer)
        return {
          items: pickerItems(list, (group) => side.includes(group)),
          initial: preselect(side, current.model),
          provider: current.model.split('/')[0] ?? null,
        }
      }),
    apply: async (sessionId, model) => {
      await withApi(api, (c) => c.setSessionModel(sessionId, model))
    },
  }
}

// offerSwitch says which credit ran out and asks, in one prompt, whether to
// top up or switch this session, with the design's warning; on switch, the
// model is picked from the other side (preselected only for the same
// OpenRouter model) and posted. True means the next turn can go on.
async function offerSwitch(
  api: ApiContext,
  sessionId: string,
  out: 'orca_credit' | 'provider_quota',
  reason: string,
): Promise<boolean> {
  const sessions = switcher(api)
  const offer = await sessions.load(sessionId)
  process.stderr.write(`${stripControlSequences(reason)}\n`)
  const { render } = await import('ink')
  const { SwitchPrompt } = await import('../ui/SwitchPrompt.js')
  const choice = await new Promise<SwitchChoice>((resolve) => {
    let settled = false
    const finish = (value: SwitchChoice) => {
      if (settled) return
      settled = true
      instance.unmount()
      resolve(value)
    }
    const instance = render(<SwitchPrompt out={out} offer={offer} onDone={finish} />, { exitOnCtrlC: true })
    // Ctrl-C unmounts Ink without a choice: treated as a top-up.
    void instance.waitUntilExit().then(() => finish({ kind: 'top-up' }))
  })
  if (choice.kind === 'no-models') {
    process.stderr.write(`${hintText('No provider key is saved. Set one in the dashboard, Settings, Providers.')}\n`)
    return false
  }
  if (choice.kind !== 'switch') return false
  await sessions.apply(sessionId, choice.model)
  process.stderr.write(`${hintText(`Switched: this session's next turn runs on ${choice.model}.`)}\n`)
  return true
}

async function runSingleShot(
  api: ApiContext,
  agentId: string | undefined,
  message: string,
  opts: ChatOpts,
  json: boolean,
): Promise<void> {
  const client = await api.client.v1()
  const sessionId = await withApi(api, () => openSession(client, agentId, opts))
  // The session id goes to stderr so scripts can capture it and resume
  // (stdout is reserved for the answer or the NDJSON events), however the
  // turn ends, a refusal included.
  let named = false
  const nameSession = () => {
    if (named) return
    named = true
    process.stderr.write(`session ${sessionId}\n`)
  }
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)
  try {
    let wroteText = false
    // A message refused at admission for Orca credit: at a terminal, offer
    // the switch. Null means it was switched and the message goes again;
    // anything else is rethrown as it came.
    const switchedAfterRefusal = async (err: unknown): Promise<null> => {
      const code = err instanceof APIError ? (err.code ?? undefined) : undefined
      if (refusedAtAdmission(code) && !json && interactive()) {
        nameSession()
        const reason = err instanceof Error ? err.message : String(err)
        if (await offerSwitch(api, sessionId, 'orca_credit', reason)) return null
      }
      throw err
    }
    const result = await withApi(api, () =>
      streamTurn(client, sessionId, message, {
        signal: controller.signal,
        onRaw: json ? emitNdjson : undefined,
        onEvent: json
          ? undefined
          : (event) => {
              if (event.type === 'delta') {
                // Remote text: never let embedded escape sequences through,
                // even to a pipe (downstream terminals re-render them).
                process.stdout.write(stripControlSequences(event.text))
                wroteText = true
              } else {
                noteTool(event)
              }
            },
      }).catch(switchedAfterRefusal),
    )
    if (result === null) {
      await runSingleShot(api, undefined, message, { ...opts, session: sessionId }, json)
      return
    }

    if (result.terminated === 'aborted') {
      if (!json && wroteText) process.stdout.write('\n')
      nameSession()
      throw new CliError('interrupted', ExitCode.Interrupt)
    }
    if (!json) {
      if (!wroteText && result.message) process.stdout.write(stripControlSequences(result.message))
      process.stdout.write('\n')
    }
    nameSession()
    if (result.terminated === 'error') {
      // A credit ran out: at a terminal, offer the switch of who pays, then
      // continue the same session on it (orca-design model-billing D3.13).
      const out = creditOut(result.errorCode, result.errorParam)
      if (out && !json && interactive() && (await offerSwitch(api, sessionId, out, result.message))) {
        await runSingleShot(api, undefined, CONTINUE_MESSAGE, { ...opts, session: sessionId }, json)
        return
      }
      throw new CliError(result.message || result.errorCode || 'the turn failed', ExitCode.Failure)
    }
    if (result.terminated === 'dropped') {
      throw new CliError('the event stream closed before the turn ended', ExitCode.Failure, [
        `The turn may still finish. Check it with: orca sessions items ${sessionId}`,
      ])
    }
  } finally {
    nameSession()
    process.removeListener('SIGINT', onSigint)
  }
}

async function runRepl(
  api: ApiContext,
  agentId: string | undefined,
  label: string,
  opts: ChatOpts,
): Promise<void> {
  const client = await api.client.v1()
  const { render } = await import('ink')
  const { Chat } = await import('../ui/Chat.js')

  // The REPL never rejects on a failed turn: HTTP-level failures are mapped
  // to an error result so a bad turn keeps the REPL alive. The session is
  // created on the first message, so an empty REPL creates nothing.
  const send: SendTurn = async (message, handlers, sessionId) => {
    // Kept across a failure: a session made before the turn failed is the
    // one the next message continues.
    let id = sessionId
    try {
      id = id ?? (await openSession(client, agentId, opts))
      const result = await streamTurn(client, id, message, { signal: handlers.signal, onEvent: handlers.onEvent })
      return { ...result, sessionId: id }
    } catch (err) {
      const mapped = mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
      // The code stays, so a refusal for Orca credit offers the switch.
      const errorCode = err instanceof APIError ? (err.code ?? undefined) : undefined
      return { terminated: 'error' as const, message: mapped.message, errorCode, sessionId: id }
    }
  }

  // On leaving, the session is named so it can be continued with --session.
  const onExit = (sessionId?: string) => {
    if (sessionId) process.stderr.write(`session ${sessionId}\n`)
  }
  const instance = render(
    <Chat agentLabel={label} initialSessionId={opts.session} send={send} switcher={switcher(api)} onExit={onExit} />,
    { exitOnCtrlC: false },
  )
  await instance.waitUntilExit()
}

// pickAgent opens the picker over the tenant's agents so an interactive
// `orca chat` with no agent still resolves one.
async function pickAgent(api: ApiContext): Promise<{ id: string; label: string }> {
  const page = await fetchAll((params) =>
    withApi(api, async (c) => toPage(await (await c.v1()).beta.agents.list(params))),
  )
  if (page.items.length === 0) {
    throw new CliError('no agents to chat with', ExitCode.Usage, [
      'Create one first: orca agents create -f agent.yaml',
    ])
  }
  const { pickOne } = await import('../ui/AgentPicker.js')
  const label = (a: { id: string; name: string | null }) => `${a.name ?? '(unnamed)'}  ${a.id}`
  const chosen = await pickOne('Select an agent', page.items.map(label))
  const agent = page.items.find((a) => label(a) === chosen)!
  return { id: agent.id, label: agent.name ?? agent.id }
}

export function registerChat(program: Command): void {
  addSessionCreateOptions(
    program
      .command('chat [agent] [prompt...]')
      .description('chat with an agent in a session (a REPL, or one turn with a prompt or stdin)')
      .option('--session <id>', 'continue this session instead of starting a new one'),
  ).action(async (agentArg: string | undefined, promptParts: string[], opts: ChatOpts, cmd: Command) => {
    const flags = globalFlags(cmd)
    const json = Boolean(flags.json)
    const piped = !process.stdin.isTTY
    const api = await apiContext(cmd)

    // The agent names the session's agent for a new session. Continuing one
    // (--session) needs no agent; when both are given the agent is a label.
    let agentId: string | undefined
    let label = agentArg ?? opts.session ?? ''
    if (!opts.session && agentArg) {
      agentId = await withApi(api, async (c) => resolveAgentId(await c.v1(), agentArg))
      // Refuses a malformed flag before anything is sent.
      sessionCreateParams(agentId, opts)
    } else if (!agentArg && !opts.session) {
      if (json || piped || !interactive()) {
        throw new CliError('agent required', ExitCode.Usage, [
          'Usage: orca chat <agent> "message"',
          'Or pipe stdin: echo hi | orca chat <agent>',
        ])
      }
      const picked = await pickAgent(api)
      agentId = picked.id
      label = picked.label
    }

    const prompt = promptParts.join(' ').trim()
    if (!json && !prompt && !piped && interactive()) {
      await runRepl(api, agentId, label, opts)
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
    await runSingleShot(api, agentId, message, opts, json)
  })
}
