// Files written by `orca harness init`.
//
// A harness is one file. `index.ts` creates a server from
// @agent-orc/harness-protocol and hands it a `run` function, and that function
// is the whole of what a harness author writes. The protocol half (HTTP
// routing, NDJSON framing, event ordering, cancellation, request limits, state
// transfer, MCP tool connection) lives in the library, so a fix there reaches
// every harness on upgrade instead of every harness having its own copy to
// keep right.
//
// The SDK choice only changes index.ts. Nothing else in the scaffold knows
// which SDK you picked, which is what makes swapping one a single-file edit.
//
// TypeScript, run directly. Node strips types natively, so there is no build
// step: the image copies source and runs it. typescript and @types/node are
// devDependencies for `npm run typecheck` and editor completion.
//
// The SDK versions below are pinned to the ranges the platform's own sidecar
// uses (agent-worker/package.json), so a harness is built against the same
// generation of each SDK the platform runs itself.

export type ScaffoldFile = { path: string; content: string; mode?: number }

export const HARNESS_SDKS = ['none', 'claude', 'codex', 'pi', 'vercel', 'opencode'] as const
export type HarnessSdk = (typeof HARNESS_SDKS)[number]

/** The protocol library version a fresh harness is pinned to. */
export const DEFAULT_PROTOCOL_SPEC = '^1.0.0'

export const PROTOCOL_PACKAGE = '@agent-orc/harness-protocol'

export type ScaffoldOptions = {
  /**
   * Dependency specifier for the protocol library. Overridable so a harness
   * can be built against a local checkout or a packed tarball before the
   * version it wants is on the registry.
   */
  protocol?: string
}

type SdkMeta = {
  /** Shown in --help and in the init summary. */
  label: string
  /** Runtime dependencies beyond the protocol library. */
  deps: Record<string, string>
  /** Provider credential the agent reads, if any. */
  envVar?: string
  /**
   * Whether this SDK consumes ctx.tools. The ones that take MCP server
   * configuration directly connect for themselves, and having the library
   * connect too would open every session's tools twice.
   */
  usesCtxTools: boolean
  agent: string
}

// ---------------------------------------------------------------------------
// index.ts, per SDK. This is the only file that differs.
// ---------------------------------------------------------------------------

const AGENT_NONE = `// Your harness.
//
// The stub echoes the prompt, so this is conformant before you write anything.
// Replace the body of run() with your agent.

import { createHarnessServer, type RunContext } from '@agent-orc/harness-protocol'

const harness = createHarnessServer({
  // Names this implementation in /health. Not the protocol, not the template.
  runtime: process.env.HARNESS_NAME || 'my-harness',

  async run(ctx: RunContext) {
    ctx.emit.progress('thinking')

    // ctx.tools holds the platform tools this profile was granted, already
    // connected. Calling one reports itself to the platform transcript.
    for (const tool of ctx.tools) {
      ctx.emit.progress(\`tool available: \${tool.name}\`)
    }

    // ctx.signal aborts when the platform cancels. Thread it into your model
    // and tool calls or you keep spending tokens on an answer nobody reads.
    if (ctx.signal.aborted) throw new Error('cancelled')

    return \`echo: \${ctx.subtask.prompt}\`
  },
})

await harness.listen({ port: Number(process.env.PORT ?? 7099) })
`

const AGENT_CLAUDE = `// Your harness, on the Claude Agent SDK.
//
// Needs ANTHROPIC_API_KEY in the environment.

import { createHarnessServer, type RunContext } from '@agent-orc/harness-protocol'
import { query } from '@anthropic-ai/claude-agent-sdk'

const harness = createHarnessServer({
  runtime: process.env.HARNESS_NAME || 'my-harness',

  // The Claude SDK speaks MCP directly, so it connects to the session endpoint
  // itself. Letting the library connect as well would open the same tools
  // twice per run.
  tools: false,

  async run(ctx: RunContext) {
    // The SDK takes an AbortController rather than a signal, so bridge the one
    // the platform gave us into a fresh controller.
    const abort = new AbortController()
    if (ctx.signal.aborted) abort.abort()
    else ctx.signal.addEventListener('abort', () => abort.abort(), { once: true })

    const mcpServers: Record<string, { type: 'http'; url: string }> = {}
    if (ctx.request.sessionMcpUrl) {
      mcpServers.runner = { type: 'http', url: ctx.request.sessionMcpUrl }
    }

    const texts: string[] = []

    for await (const message of query({
      prompt: ctx.subtask.prompt,
      options: {
        abortController: abort,
        ...(ctx.profile.systemPrompt ? { systemPrompt: ctx.profile.systemPrompt } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        // Read no configuration from the host. A harness must behave the same
        // wherever it runs, and must not pick up whoever built the image.
        settingSources: [],
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        // Publish the SDK's own conversation id so the platform can resume it.
        ctx.emit.session(message.session_id)
      }

      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            texts.push(block.text)
            ctx.emit.assistant(block.text)
          } else if (block.type === 'tool_use') {
            ctx.emit.toolCall(block.id, block.name, block.input)
          }
        }
      }

      if (message.type === 'result') {
        ctx.emit.usage({
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens,
        })
      }
    }

    return texts.join('\\n').trim()
  },
})

await harness.listen({ port: Number(process.env.PORT ?? 7099) })
`

const AGENT_CODEX = `// Your harness, on the Codex SDK.
//
// Needs OPENAI_API_KEY in the environment.

import { createHarnessServer, type RunContext } from '@agent-orc/harness-protocol'
import { Codex } from '@openai/codex-sdk'

const harness = createHarnessServer({
  runtime: process.env.HARNESS_NAME || 'my-harness',

  // Codex takes MCP servers in its own config, so it connects for itself.
  tools: false,

  async run(ctx: RunContext) {
    const client = new Codex()
    const thread = client.startThread()

    // runStreamed rather than run, so tool calls and messages surface as they
    // happen instead of arriving all at once when the turn ends.
    const streamed = await thread.runStreamed(ctx.subtask.prompt, { signal: ctx.signal })

    const texts: string[] = []
    const seen = new Set<string>()

    for await (const event of streamed.events) {
      if (event.type === 'thread.started') {
        ctx.emit.session(event.thread_id)
        continue
      }

      if (event.type === 'item.completed') {
        const item = event.item
        // item.updated fires before item.completed for the same id; dedupe so
        // a tool call is not reported twice.
        if (seen.has(item.id)) continue
        seen.add(item.id)

        if (item.type === 'agent_message') {
          texts.push(item.text)
          ctx.emit.assistant(item.text)
        } else if (item.type === 'command_execution') {
          ctx.emit.toolCall(item.id, 'command', { command: item.command })
        }
      }
    }

    return texts.join('\\n').trim()
  },
})

await harness.listen({ port: Number(process.env.PORT ?? 7099) })
`

const AGENT_PI = `// Your harness, on the Pi coding agent SDK (https://pi.dev).
//
// Pi runs in-process: there is no separate server to start. The model it uses
// is whatever your Pi configuration selects.

import { createHarnessServer, type RunContext } from '@agent-orc/harness-protocol'
import {
  createAgentSession,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'

const harness = createHarnessServer({
  runtime: process.env.HARNESS_NAME || 'my-harness',

  async run(ctx: RunContext) {
    // The platform's tools arrive generic. This is where a Pi harness makes
    // them Pi's; tool.call reports itself to the transcript on the way.
    const customTools: ToolDefinition[] = ctx.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // Pi types this as a TypeBox TSchema. A TypeBox schema is a JSON Schema
      // object at runtime and the platform hands us JSON Schema, so this is a
      // naming difference rather than a shape difference.
      parameters: tool.inputSchema as unknown as ToolDefinition['parameters'],
      // Pi wants a content array back, not a bare value.
      async execute(toolCallId: string, params: unknown) {
        const output = await tool.call(params, { toolCallId })
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof output === 'string' ? output : JSON.stringify(output),
            },
          ],
          details: undefined,
        }
      },
    }))

    // No model is passed: Pi takes a resolved Model object from its own runtime
    // rather than a model id string, so let Pi choose from its configuration.
    const { session } = await createAgentSession({
      // In-memory: the platform owns durability, and a harness that wrote state
      // to its own disk would lose it when the session moves.
      sessionManager: SessionManager.inMemory(),
      tools: customTools.map((t) => t.name),
      customTools,
    })

    // prompt() resolves with void, so the answer is assembled from the event
    // stream rather than returned.
    let text = ''
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent
        if (delta?.type === 'text_delta' && delta.delta) {
          text += delta.delta
          ctx.emit.assistant(delta.delta)
        }
      }
    })

    const onAbort = (): void => {
      void session.abort()
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    try {
      await session.prompt(ctx.subtask.prompt)
    } finally {
      unsubscribe()
      ctx.signal.removeEventListener('abort', onAbort)
    }

    const failure = session.agent?.state?.errorMessage
    if (failure && !text) throw new Error(\`pi sdk: \${failure}\`)

    return text
  },
})

await harness.listen({ port: Number(process.env.PORT ?? 7099) })
`

const AGENT_VERCEL = `// Your harness, on the Vercel AI SDK.
//
// Needs ANTHROPIC_API_KEY in the environment for the default model below.
// Swap the provider import to use a different one.

import { createHarnessServer, type RunContext } from '@agent-orc/harness-protocol'
import { anthropic } from '@ai-sdk/anthropic'
import { jsonSchema, stepCountIs, streamText, tool, type ToolSet } from 'ai'

// Model ids arrive provider-prefixed ("anthropic:claude-sonnet-4-5"); the
// provider factory wants the bare id.
function bareModelId(model: string | undefined, fallback: string): string {
  if (!model) return fallback
  const colon = model.indexOf(':')
  return colon === -1 ? model : model.slice(colon + 1)
}

const harness = createHarnessServer({
  runtime: process.env.HARNESS_NAME || 'my-harness',

  async run(ctx: RunContext) {
    // The platform's tools arrive generic, with JSON Schema for arguments,
    // which is exactly what jsonSchema() wants.
    const tools: ToolSet = Object.fromEntries(
      ctx.tools.map((t) => [
        t.name,
        tool({
          description: t.description,
          inputSchema: jsonSchema(t.inputSchema),
          execute: (input: unknown) => t.call(input),
        }),
      ]),
    )

    const result = streamText({
      model: anthropic(bareModelId(ctx.profile.model, 'claude-sonnet-4-5')),
      ...(ctx.profile.systemPrompt ? { system: ctx.profile.systemPrompt } : {}),
      prompt: ctx.subtask.prompt,
      abortSignal: ctx.signal,
      tools,
      // Without a stop condition a tool-using agent runs one step and stops.
      stopWhen: stepCountIs(16),
    })

    const texts: string[] = []

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        texts.push(part.text)
        ctx.emit.assistant(part.text)
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
      // tool-call and tool-result are not forwarded here: ctx.tools already
      // reports every call it runs, and doing both would double the transcript.
    }

    const usage = await result.usage
    ctx.emit.usage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })

    return texts.join('')
  },
})

await harness.listen({ port: Number(process.env.PORT ?? 7099) })
`

const AGENT_OPENCODE = `// Your harness, on the OpenCode SDK.
//
// OpenCode runs as a local server that this harness starts in-process and
// talks to over its client. Provider credentials come from the OpenCode
// configuration, e.g. ANTHROPIC_API_KEY for the model below.

import { createHarnessServer, type RunContext } from '@agent-orc/harness-protocol'
import { createOpencode } from '@opencode-ai/sdk'

// "anthropic/claude-sonnet-4-5" and "anthropic:claude-sonnet-4-5" both appear
// in the wild; OpenCode wants the two halves separately.
function splitModel(model: string | undefined): { providerID: string; modelID: string } {
  const raw = model ?? 'anthropic/claude-sonnet-4-5'
  const at = raw.search(/[/:]/)
  if (at === -1) return { providerID: 'anthropic', modelID: raw }
  return { providerID: raw.slice(0, at), modelID: raw.slice(at + 1) }
}

const harness = createHarnessServer({
  runtime: process.env.HARNESS_NAME || 'my-harness',

  // OpenCode manages its own MCP configuration.
  tools: false,

  async run(ctx: RunContext) {
    const model = splitModel(ctx.profile.model)

    // Port 0 lets the OS pick a free port, so two sessions on one host cannot
    // collide.
    const opencode = await createOpencode({ hostname: '127.0.0.1', port: 0 })

    try {
      ctx.emit.progress('starting the opencode session')

      // Every client call answers { data, error } rather than the value
      // directly, so both halves have to be handled on each one.
      const created = await opencode.client.session.create({
        body: { title: ctx.subtask.title ?? ctx.subtask.id },
      })
      if (created.error || !created.data) {
        throw new Error(\`opencode could not create a session: \${JSON.stringify(created.error)}\`)
      }
      const sessionId = created.data.id
      ctx.emit.session(sessionId)

      if (ctx.signal.aborted) throw new Error('cancelled')

      const result = await opencode.client.session.prompt({
        path: { id: sessionId },
        body: { model, parts: [{ type: 'text', text: ctx.subtask.prompt }] },
      })
      if (result.error) throw new Error(\`opencode run failed: \${JSON.stringify(result.error)}\`)

      const text = textOf(result.data)
      ctx.emit.assistant(text)
      return text
    } finally {
      // Always stop the server: the process outlives one run, and a leaked
      // server per run would exhaust the box.
      opencode.server.close()
    }
  },
})

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

await harness.listen({ port: Number(process.env.PORT ?? 7099) })
`

// ---------------------------------------------------------------------------

const SDKS: Record<HarnessSdk, SdkMeta> = {
  none: {
    label: 'no SDK, an echo stub you replace',
    deps: {},
    usesCtxTools: true,
    agent: AGENT_NONE,
  },
  claude: {
    label: 'Claude Agent SDK',
    deps: { '@anthropic-ai/claude-agent-sdk': '^0.2.141' },
    envVar: 'ANTHROPIC_API_KEY',
    usesCtxTools: false,
    agent: AGENT_CLAUDE,
  },
  codex: {
    label: 'Codex SDK',
    deps: { '@openai/codex-sdk': '^0.120.0' },
    envVar: 'OPENAI_API_KEY',
    usesCtxTools: false,
    agent: AGENT_CODEX,
  },
  pi: {
    label: 'Pi coding agent SDK',
    deps: { '@earendil-works/pi-coding-agent': '^0.83.0' },
    usesCtxTools: true,
    agent: AGENT_PI,
  },
  vercel: {
    label: 'Vercel AI SDK',
    deps: { '@ai-sdk/anthropic': '^2.0.85', ai: '^5.0.210' },
    envVar: 'ANTHROPIC_API_KEY',
    usesCtxTools: true,
    agent: AGENT_VERCEL,
  },
  opencode: {
    label: 'OpenCode SDK',
    deps: { '@opencode-ai/sdk': '^1.18.18' },
    envVar: 'ANTHROPIC_API_KEY',
    usesCtxTools: false,
    agent: AGENT_OPENCODE,
  },
}

export function sdkLabel(sdk: HarnessSdk): string {
  return SDKS[sdk].label
}

/** Whether this SDK's scaffold reads ctx.tools, for the init summary. */
export function sdkUsesCtxTools(sdk: HarnessSdk): boolean {
  return SDKS[sdk].usesCtxTools
}

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

function packageJson(sdk: HarnessSdk, opts: ScaffoldOptions): string {
  const meta = SDKS[sdk]
  return (
    JSON.stringify(
      {
        name: 'my-harness',
        version: '0.1.0',
        private: true,
        type: 'module',
        engines: { node: '>=22.18' },
        scripts: { start: 'node index.ts', typecheck: 'tsc --noEmit' },
        dependencies: {
          [PROTOCOL_PACKAGE]: opts.protocol ?? DEFAULT_PROTOCOL_SPEC,
          ...meta.deps,
        },
        devDependencies: { '@types/node': '^24.0.0', typescript: '^5.9.0' },
      },
      null,
      2,
    ) + '\n'
  )
}

const DOCKERFILE = `# Two stages so the runtime image carries no npm cache and no dev
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
COPY index.ts ./

# The harness runs tenant prompts against tenant tools, so it should hold
# nothing it does not need. node:alpine ships a 'node' user for this.
USER node

# The platform sets PORT. This default only matters when running by hand.
ENV PORT=7099
EXPOSE 7099

# Straight to node, no shell wrapper, so SIGTERM reaches the process and the
# library's drain handler actually runs.
CMD ["node", "index.ts"]
`

function readme(sdk: HarnessSdk): string {
  const meta = SDKS[sdk]
  const key = meta.envVar

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
session-scoped MCP endpoint in the run envelope.
`
    : ''

  const toolsNote = meta.usesCtxTools
    ? `\`ctx.tools\` holds the platform tools this profile was granted, already
connected and mapped into the SDK's own tool shape. Calling one reports itself
to the Orca transcript.`
    : `This SDK speaks MCP itself, so the scaffold passes it the session endpoint
directly and sets \`tools: false\` on the harness. Letting the library connect
as well would open the same tools twice per run.`

  return `# my-harness

An Orca harness: a service Orca boots per session and drives over Orca Harness
Protocol v1. This one is built on the **${meta.label}**.

One file:

| File | What it is |
|---|---|
| \`index.ts\` | **Your agent.** The \`run\` function is the whole harness. |

The protocol itself lives in \`${PROTOCOL_PACKAGE}\`: HTTP routing, NDJSON
framing, event ordering, cancellation, request limits, state transfer, and MCP
tool connection. You do not implement any of it, and a fix there reaches this
harness on upgrade.

${toolsNote}

## Run it

\`\`\`bash
npm install
npm start
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
## Keeping state between runs

Return an object instead of a string and the value comes back as \`ctx.state\`
on the next run for that session, even after Orca has moved the session to a
different replica:

\`\`\`ts
return { message: 'the answer', state: { messages } }
\`\`\`

## Ship it

\`\`\`bash
orca harness deploy my-harness .
\`\`\`

That builds for linux/amd64, pushes to Orca's registry, imports the resulting
digest as a new template version, waits for it to be ready, and activates it.
No registry account of your own required.

To push somewhere else, pass \`--image ghcr.io/<org>/my-harness\`. Your image
then has to be pullable without credentials, because the platform mirrors it
into its own registry and cannot authenticate to a private source registry
yet. On GitHub Container Registry a new package is private by default.
`
}

export function scaffoldFiles(
  sdk: HarnessSdk = 'none',
  opts: ScaffoldOptions = {},
): ScaffoldFile[] {
  return [
    { path: 'index.ts', content: SDKS[sdk].agent },
    { path: 'package.json', content: packageJson(sdk, opts) },
    { path: 'tsconfig.json', content: TSCONFIG_JSON },
    { path: 'Dockerfile', content: DOCKERFILE },
    { path: '.dockerignore', content: DOCKERIGNORE },
    { path: 'README.md', content: readme(sdk) },
  ]
}

/** Back-compat for callers that want the default template's file list. */
export const SCAFFOLD_FILES: ScaffoldFile[] = scaffoldFiles('none')
