// Files written by `orca harness init`.
//
// Every template is the same harness with a different agent in it. The
// protocol half (protocol.ts, server.ts) is byte-identical across all of them
// and is what makes the thing a harness; agent.ts is the only file that knows
// which SDK you picked. That split is the point: swapping SDKs is one file,
// and a bug fixed in the protocol is fixed everywhere.
//
// TypeScript, run directly. Node strips types natively, so there is no build
// step: the image copies source and runs it. typescript and @types/node are
// devDependencies for `npm run typecheck` and editor completion.
//
// The SDK versions below are pinned to the ranges the platform's own sidecar
// uses (agent-worker/package.json), so a harness is built against the same
// generation of each SDK the platform runs itself.
//
// Keep this in step with docs/harness-protocol/v1/spec.md in the platform
// repo. The wire rules encoded here are the ones a hand-written harness gets
// wrong most often: a terminal event must be the last thing on the stream, a
// disconnect must not take the process down, and /state must answer 404 when
// there is nothing stored rather than erroring.

export type ScaffoldFile = { path: string; content: string; mode?: number }

export const HARNESS_SDKS = ['none', 'claude', 'codex', 'pi', 'vercel', 'opencode'] as const
export type HarnessSdk = (typeof HARNESS_SDKS)[number]

type SdkMeta = {
  /** Shown in --help and in the init summary. */
  label: string
  /** Runtime dependencies. Empty means the image needs no install at all. */
  deps: Record<string, string>
  /** Provider credential the agent reads, if any. */
  envVar?: string
  agent: string
}

// ---------------------------------------------------------------------------
// Shared: the protocol. Identical in every template.
// ---------------------------------------------------------------------------

const PROTOCOL_TS = `// Orca Harness Protocol v1, as types.
//
// This file is the wire contract. It is identical in every harness template,
// and you should not need to change it. An event your editor accepts here is
// an event the platform understands.

/** The envelope the platform POSTs to /run. */
export type RunRequest = {
  sessionId: string
  profile: {
    name: string
    runtime: string
    systemPrompt?: string
    model?: string
    tools?: string[]
    template?: { name: string; version?: number }
  }
  subtask: {
    id: string
    sessionId: string
    prompt: string
    title?: string
  }
  /** Session-scoped MCP endpoint exposing the platform tools this profile was granted. */
  sessionMcpUrl?: string
  /** External MCP servers. Header values are already resolved: treat them as secrets. */
  mcpServers?: { name: string; transport: string; url: string; headers?: Record<string, string> }[]
  /** Resolved skill documents. Use these; never read skills off the host filesystem. */
  skills?: { name: string; body: string }[]
}

/** The complete v1 event vocabulary. The platform treats anything else as progress. */
export type HarnessEvent =
  | { type: 'progress'; message: string }
  | { type: 'assistant'; message: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input?: unknown }
  | { type: 'tool_result'; toolCallId: string; output?: unknown; isError?: boolean }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'session'; runtimeSessionId: string }
  | { type: 'result'; message: string }
  | { type: 'error'; message: string }

export type Emit = (event: HarnessEvent) => void

/** What server.ts hands your agent. */
export type AgentContext = {
  body: RunRequest
  /**
   * Send one event. Call it as often as you like with 'progress' or
   * 'assistant'; server.ts emits the single terminal event.
   */
  emit: Emit
  /**
   * Aborts when the platform cancels the run by closing the connection.
   * Thread it into your model and tool calls or you will keep spending tokens
   * on an answer nobody will read.
   */
  signal: AbortSignal
}
`

const SERVER_TS = `// The Orca harness protocol server.
//
// This file is identical in every harness template and implements the whole
// contract. Your agent lives in agent.ts; you should not need to change
// anything here.

import http from 'node:http'

import type { HarnessEvent, RunRequest } from './protocol.ts'
import { runAgent } from './agent.ts'

const PORT = Number(process.env.PORT || 7099)

// Names this implementation in /health. Not the protocol name.
const RUNTIME = process.env.HARNESS_NAME || 'my-harness'

// Stable for the process lifetime, different per replica, so the platform can
// tell instances apart.
const INSTANCE_ID = \`\${RUNTIME}-\${process.pid}-\${Math.random().toString(36).slice(2, 8)}\`

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function handleHealth(res: http.ServerResponse): void {
  sendJSON(res, 200, {
    ok: true,
    runtime: RUNTIME,
    protocol: 'orca-harness/v1',
    instanceId: INSTANCE_ID,
    uptimeSeconds: Math.round(process.uptime()),
  })
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: RunRequest
  try {
    body = JSON.parse(await readBody(req)) as RunRequest
  } catch {
    return sendJSON(res, 400, { error: 'invalid JSON body' })
  }
  // The three required top-level fields. A malformed envelope is a 400 before
  // the stream opens, never an error event on a 200.
  if (!body?.sessionId || !body?.profile || !body?.subtask) {
    return sendJSON(res, 400, { error: 'sessionId, profile, and subtask are required' })
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
  })

  // Cancellation is a closed connection; there is no /cancel endpoint.
  const ac = new AbortController()
  req.on('close', () => ac.abort())

  let done = false
  const emit = (event: HarnessEvent): void => {
    // Nothing may follow a terminal event, and a write racing a closed socket
    // must not take the process down.
    if (done || res.writableEnded || res.destroyed) return
    if (event.type === 'result' || event.type === 'error') done = true
    res.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\\n')
  }

  try {
    const message = await runAgent({ body, emit, signal: ac.signal })
    emit({ type: 'result', message: String(message ?? '') })
  } catch (err) {
    // A cancelled run gets no terminal event: the socket is gone and it could
    // not be delivered anyway.
    if (!ac.signal.aborted) {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    if (!res.writableEnded) res.end()
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const server = http.createServer((req, res) => {
  // split always yields at least one element, but noUncheckedIndexedAccess
  // does not know that, and the fallback costs nothing.
  const path = (req.url || '/').split('?')[0] ?? '/'

  if (req.method === 'GET' && path === '/health') return handleHealth(res)
  if (req.method === 'POST' && path === '/run') return void handleRun(req, res)

  // State transfer is optional. 404 is the correct "nothing stored" answer and
  // is what keeps a stateless harness conformant. To make this harness
  // stateful, implement BOTH GET and POST /state/{sessionId}.
  if (path.startsWith('/state/')) {
    if (req.method === 'GET') return sendJSON(res, 404, { error: 'no state for this session' })
    if (req.method === 'POST') return sendJSON(res, 404, { error: 'state import not implemented' })
  }

  sendJSON(res, 404, { error: 'not found' })
})

// A malformed request line must not be fatal.
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n')
  else socket.destroy()
})

server.listen(PORT, () => {
  console.log(\`\${RUNTIME} listening on \${PORT}\`)
})

// Drain rather than drop in-flight runs when the platform stops the container.
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],

    "strict": true,
    "noUncheckedIndexedAccess": true,

    // Check your code, not your dependencies. Several agent SDKs ship .d.ts
    // files that reference DOM types or optional peers they do not declare,
    // so without this a brand new project fails typecheck on errors it cannot
    // fix. Your own files are still fully checked.
    "skipLibCheck": true,

    // Node strips types rather than compiling them, so these files are only
    // ever type-checked, never emitted.
    "noEmit": true,
    "allowImportingTsExtensions": true,

    // Refuse TypeScript that cannot simply be erased (enums, namespaces,
    // parameter properties). Those need a real compiler, so they type-check
    // fine and then fail at runtime under type stripping. This turns that
    // into an error you see immediately.
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true
  },
  "include": ["*.ts"]
}
`

const DOCKERIGNORE = `node_modules
npm-debug.log
.git
.gitignore
.DS_Store
tsconfig.json
`

// ---------------------------------------------------------------------------
// The agent, per SDK. This is the only file that differs.
// ---------------------------------------------------------------------------

const AGENT_NONE = `// Your agent. This is the only file you need to change.
//
// The stub echoes the prompt so the harness is conformant before you write
// anything. Replace the body of runAgent with your loop.

import type { AgentContext } from './protocol.ts'

export async function runAgent({ body, emit, signal }: AgentContext): Promise<string> {
  const prompt = body.subtask.prompt ?? ''

  emit({ type: 'progress', message: 'thinking' })

  // The platform tools granted to this profile are at body.sessionMcpUrl, an
  // MCP endpoint scoped to this session. body.skills holds resolved skill
  // documents; use them as given.
  if (signal.aborted) throw new Error('cancelled')

  return \`echo: \${prompt}\`
}
`

const AGENT_CLAUDE = `// Your agent, on the Claude Agent SDK.
//
// Needs ANTHROPIC_API_KEY in the environment.

import { query } from '@anthropic-ai/claude-agent-sdk'

import type { AgentContext } from './protocol.ts'

export async function runAgent({ body, emit, signal }: AgentContext): Promise<string> {
  // The SDK takes an AbortController rather than a signal, so bridge the one
  // the platform gave us into a fresh controller.
  const abort = new AbortController()
  if (signal.aborted) abort.abort()
  else signal.addEventListener('abort', () => abort.abort(), { once: true })

  const texts: string[] = []

  for await (const message of query({
    prompt: body.subtask.prompt,
    options: {
      abortController: abort,
      ...(body.profile.systemPrompt
        ? { systemPrompt: body.profile.systemPrompt }
        : {}),
      // Read no configuration from the host. A harness must behave the same
      // wherever it runs, and must not pick up whoever built the image.
      settingSources: [],
    },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      // Publish the SDK's own conversation id so the platform can resume it.
      emit({ type: 'session', runtimeSessionId: message.session_id })
    }

    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          texts.push(block.text)
          emit({ type: 'assistant', message: block.text })
        } else if (block.type === 'tool_use') {
          emit({
            type: 'tool_call',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          })
        }
      }
    }

    if (message.type === 'result') {
      emit({
        type: 'usage',
        usage: {
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens,
        },
      })
    }
  }

  return texts.join('\\n').trim()
}
`

const AGENT_CODEX = `// Your agent, on the Codex SDK.
//
// Needs OPENAI_API_KEY in the environment.

import { Codex } from '@openai/codex-sdk'

import type { AgentContext } from './protocol.ts'

export async function runAgent({ body, emit, signal }: AgentContext): Promise<string> {
  const client = new Codex()
  const thread = client.startThread()

  // runStreamed rather than run, so tool calls and messages surface as they
  // happen instead of arriving all at once when the turn ends.
  const streamed = await thread.runStreamed(body.subtask.prompt, { signal })

  const texts: string[] = []
  const seen = new Set<string>()

  for await (const event of streamed.events) {
    if (event.type === 'thread.started') {
      emit({ type: 'session', runtimeSessionId: event.thread_id })
      continue
    }

    if (event.type === 'item.completed') {
      const item = event.item
      // item.updated fires before item.completed for the same id; dedupe so a
      // tool call is not reported twice.
      if (seen.has(item.id)) continue
      seen.add(item.id)

      if (item.type === 'agent_message') {
        texts.push(item.text)
        emit({ type: 'assistant', message: item.text })
      } else if (item.type === 'command_execution') {
        emit({
          type: 'tool_call',
          toolCallId: item.id,
          toolName: 'command',
          input: { command: item.command },
        })
      }
    }
  }

  return texts.join('\\n').trim()
}
`

const AGENT_PI = `// Your agent, on the Pi coding agent SDK (https://pi.dev).
//
// Pi runs in-process: there is no separate server to start. The model it uses
// is whatever your Pi configuration selects.

import {
  createAgentSession,
  SessionManager,
} from '@earendil-works/pi-coding-agent'

import type { AgentContext } from './protocol.ts'

export async function runAgent({ body, emit, signal }: AgentContext): Promise<string> {
  // No model is passed: Pi takes a resolved Model object from its own runtime
  // rather than a model id string, so let Pi choose from its configuration.
  const { session } = await createAgentSession({
    // In-memory: the platform owns durability, and a harness that wrote state
    // to its own disk would lose it when the session moves.
    sessionManager: SessionManager.inMemory(),
  })

  // prompt() resolves with void, so the answer is assembled from the event
  // stream rather than returned.
  let text = ''
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent
      if (delta?.type === 'text_delta' && delta.delta) {
        text += delta.delta
        emit({ type: 'assistant', message: delta.delta })
      }
    }
  })

  const onAbort = (): void => {
    void session.abort()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    await session.prompt(body.subtask.prompt)
  } finally {
    unsubscribe()
    signal.removeEventListener('abort', onAbort)
  }

  const failure = session.agent?.state?.errorMessage
  if (failure && !text) throw new Error(\`pi sdk: \${failure}\`)

  return text
}
`

const AGENT_VERCEL = `// Your agent, on the Vercel AI SDK.
//
// Needs ANTHROPIC_API_KEY in the environment for the default model below.
// Swap the provider import to use a different one.

import { anthropic } from '@ai-sdk/anthropic'
import { stepCountIs, streamText } from 'ai'

import type { AgentContext } from './protocol.ts'

// Model ids arrive provider-prefixed ("anthropic:claude-sonnet-4-5"); the
// provider factory wants the bare id.
function bareModelId(model: string | undefined, fallback: string): string {
  if (!model) return fallback
  const colon = model.indexOf(':')
  return colon === -1 ? model : model.slice(colon + 1)
}

export async function runAgent({ body, emit, signal }: AgentContext): Promise<string> {
  const result = streamText({
    model: anthropic(bareModelId(body.profile.model, 'claude-sonnet-4-5')),
    ...(body.profile.systemPrompt ? { system: body.profile.systemPrompt } : {}),
    prompt: body.subtask.prompt,
    abortSignal: signal,
    // Without a stop condition a tool-using agent runs one step and stops.
    stopWhen: stepCountIs(16),
  })

  const texts: string[] = []

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      texts.push(part.text)
    } else if (part.type === 'tool-call') {
      emit({
        type: 'tool_call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    } else if (part.type === 'tool-result') {
      emit({ type: 'tool_result', toolCallId: part.toolCallId, output: part.output })
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }

  const usage = await result.usage
  emit({
    type: 'usage',
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  })

  const text = texts.join('')
  emit({ type: 'assistant', message: text })
  return text
}
`

const AGENT_OPENCODE = `// Your agent, on the OpenCode SDK.
//
// OpenCode runs as a local server that this harness starts in-process and
// talks to over its client. Provider credentials come from the OpenCode
// configuration, e.g. ANTHROPIC_API_KEY for the model below.

import { createOpencode } from '@opencode-ai/sdk'

import type { AgentContext } from './protocol.ts'

// "anthropic/claude-sonnet-4-5" and "anthropic:claude-sonnet-4-5" both appear
// in the wild; OpenCode wants the two halves separately.
function splitModel(model: string | undefined): { providerID: string; modelID: string } {
  const raw = model ?? 'anthropic/claude-sonnet-4-5'
  const at = raw.search(/[/:]/)
  if (at === -1) return { providerID: 'anthropic', modelID: raw }
  return { providerID: raw.slice(0, at), modelID: raw.slice(at + 1) }
}

export async function runAgent({ body, emit, signal }: AgentContext): Promise<string> {
  const model = splitModel(body.profile.model)

  // Port 0 lets the OS pick a free port, so two sessions on one host cannot
  // collide.
  const opencode = await createOpencode({ hostname: '127.0.0.1', port: 0 })

  try {
    emit({ type: 'progress', message: 'starting the opencode session' })

    // Every client call answers { data, error } rather than the value
    // directly, so both halves have to be handled on each one.
    const created = await opencode.client.session.create({
      body: { title: body.subtask.title ?? body.subtask.id },
    })
    if (created.error || !created.data) {
      throw new Error(\`opencode could not create a session: \${JSON.stringify(created.error)}\`)
    }
    const sessionId = created.data.id
    emit({ type: 'session', runtimeSessionId: sessionId })

    if (signal.aborted) throw new Error('cancelled')

    const result = await opencode.client.session.prompt({
      path: { id: sessionId },
      body: {
        model,
        parts: [{ type: 'text', text: body.subtask.prompt }],
      },
    })
    if (result.error) throw new Error(\`opencode run failed: \${JSON.stringify(result.error)}\`)

    const text = textOf(result.data)
    emit({ type: 'assistant', message: text })
    return text
  } finally {
    // Always stop the server: the process outlives one run, and a leaked
    // server per run would exhaust the box.
    opencode.server.close()
  }
}

// The response shape varies across OpenCode versions, so pull text out
// defensively rather than pinning to one layout.
function textOf(result: unknown): string {
  const parts = (result as { parts?: { type?: string; text?: string }[] })?.parts
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim()
  }
  return typeof result === 'string' ? result : JSON.stringify(result)
}
`

// ---------------------------------------------------------------------------

const SDKS: Record<HarnessSdk, SdkMeta> = {
  none: {
    label: 'no SDK, an echo stub you replace',
    deps: {},
    agent: AGENT_NONE,
  },
  claude: {
    label: 'Claude Agent SDK',
    deps: { '@anthropic-ai/claude-agent-sdk': '^0.2.141' },
    envVar: 'ANTHROPIC_API_KEY',
    agent: AGENT_CLAUDE,
  },
  codex: {
    label: 'Codex SDK',
    deps: { '@openai/codex-sdk': '^0.120.0' },
    envVar: 'OPENAI_API_KEY',
    agent: AGENT_CODEX,
  },
  pi: {
    label: 'Pi coding agent SDK',
    deps: { '@earendil-works/pi-coding-agent': '^0.83.0' },
    agent: AGENT_PI,
  },
  vercel: {
    label: 'Vercel AI SDK',
    deps: { '@ai-sdk/anthropic': '^2.0.85', ai: '^5.0.210' },
    envVar: 'ANTHROPIC_API_KEY',
    agent: AGENT_VERCEL,
  },
  opencode: {
    label: 'OpenCode SDK',
    deps: { '@opencode-ai/sdk': '^1.18.18' },
    envVar: 'ANTHROPIC_API_KEY',
    agent: AGENT_OPENCODE,
  },
}

export function sdkLabel(sdk: HarnessSdk): string {
  return SDKS[sdk].label
}

function packageJson(sdk: HarnessSdk): string {
  const meta = SDKS[sdk]
  const pkg: Record<string, unknown> = {
    name: 'my-harness',
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=22.18' },
    scripts: { start: 'node server.ts', typecheck: 'tsc --noEmit' },
  }
  if (Object.keys(meta.deps).length > 0) pkg.dependencies = meta.deps
  pkg.devDependencies = { '@types/node': '^24.0.0', typescript: '^5.9.0' }
  return JSON.stringify(pkg, null, 2) + '\n'
}

const SOURCES = 'protocol.ts server.ts agent.ts'

function dockerfile(sdk: HarnessSdk): string {
  const hasDeps = Object.keys(SDKS[sdk].deps).length > 0
  if (!hasDeps) {
    return `# Node runs TypeScript directly by stripping types, so there is no build
# stage and nothing to install: the image is the base plus the source. That
# keeps the pull small, which is user-visible latency because the substrate
# pulls this before the first run of a session.
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
COPY package.json ./
COPY ${SOURCES} ./

# The harness runs tenant prompts against tenant tools, so it should hold
# nothing it does not need. node:alpine ships a 'node' user for this.
USER node

# The platform sets PORT. This default only matters when running by hand.
ENV PORT=7099
EXPOSE 7099

# Straight to node, no shell wrapper, so SIGTERM reaches the process and the
# drain handler in server.ts actually runs.
CMD ["node", "server.ts"]
`
  }
  return `# Two stages so the runtime image carries no npm cache and no dev
# dependencies. There is still no compile step: Node strips the types and runs
# the source directly.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# npm ci when a lockfile exists, so an image build is reproducible.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY ${SOURCES} ./

# The harness runs tenant prompts against tenant tools, so it should hold
# nothing it does not need. node:alpine ships a 'node' user for this.
USER node

# The platform sets PORT. This default only matters when running by hand.
ENV PORT=7099
EXPOSE 7099

# Straight to node, no shell wrapper, so SIGTERM reaches the process and the
# drain handler in server.ts actually runs.
CMD ["node", "server.ts"]
`
}

function readme(sdk: HarnessSdk): string {
  const meta = SDKS[sdk]
  const hasDeps = Object.keys(meta.deps).length > 0
  const key = meta.envVar

  const install = hasDeps
    ? `npm install                    # the SDK, plus the compiler and node types\n`
    : `npm install                    # only the compiler and node types; the harness itself has no deps\n`

  const keySection = key
    ? `
## Credentials

This harness calls a model provider directly, so it needs \`${key}\` in its
environment:

\`\`\`bash
export ${key}=...
npm start
\`\`\`

Provider credentials belong to you, not to Orca. The platform never sends its
own credentials to a harness, and the only authority it grants a run is the
session-scoped MCP endpoint in the \`/run\` body.
`
    : ''

  return `# my-harness

An Orca harness: a service Orca boots per session and drives over Orca Harness
Protocol v1. This one is built on the **${meta.label}**.

Three files:

| File | What it is |
|---|---|
| \`agent.ts\` | **Your agent.** The only file that knows which SDK this is. |
| \`protocol.ts\` | The wire contract as types. Identical in every harness. |
| \`server.ts\` | The protocol server. Identical in every harness. |

Swapping SDKs means rewriting \`agent.ts\` and nothing else.

## Run it

\`\`\`bash
${install}npm start                      # node runs the TypeScript directly
curl localhost:7099/health

curl -sN localhost:7099/run -H 'content-type: application/json' -d '{
  "sessionId":"s1",
  "profile":{"name":"dev","runtime":"custom"},
  "subtask":{"id":"r1","sessionId":"s1","prompt":"hello"}
}'
\`\`\`

The second command should stream newline-delimited JSON ending in a single
\`result\` event.

There is no build step: Node strips the types and runs the file. \`npm run
typecheck\` runs the compiler when you want it.
${keySection}
## Ship it

\`\`\`bash
orca harness deploy my-harness . --image ghcr.io/<org>/my-harness
\`\`\`

That builds for linux/amd64, pushes, imports the resulting digest as a new
template version, waits for it to be ready, and activates it.

Your image must be pullable without credentials: the platform mirrors it into
its own registry and cannot authenticate to a private source registry yet. On
GitHub Container Registry a new package is private by default.

## Two rules that are easy to break

A client disconnecting mid-run must not take the process down, and
\`GET /state/<id>\` must answer 404 rather than erroring when nothing is
stored. \`server.ts\` already handles both; keep them if you edit it.
`
}

export function scaffoldFiles(sdk: HarnessSdk = 'none'): ScaffoldFile[] {
  return [
    { path: 'protocol.ts', content: PROTOCOL_TS },
    { path: 'server.ts', content: SERVER_TS },
    { path: 'agent.ts', content: SDKS[sdk].agent },
    { path: 'package.json', content: packageJson(sdk) },
    { path: 'tsconfig.json', content: TSCONFIG_JSON },
    { path: 'Dockerfile', content: dockerfile(sdk) },
    { path: '.dockerignore', content: DOCKERIGNORE },
    { path: 'README.md', content: readme(sdk) },
  ]
}

/** Back-compat for callers that want the default template's file list. */
export const SCAFFOLD_FILES: ScaffoldFile[] = scaffoldFiles('none')
