// Files written by `orca harness init`.
//
// They are embedded here rather than fetched or copied from the platform repo
// because the CLI ships as a standalone binary with nothing beside it. The
// scaffold implements Orca Harness Protocol v1 and needs nothing installed to
// run, so `docker build` works on a fresh machine and the conformance checker
// passes before a single line of agent code is written.
//
// TypeScript, run directly. Node strips types natively, so there is no build
// step and no runtime dependency: the image copies one .ts file and runs it.
// typescript and @types/node are devDependencies for editor types and
// `npm run typecheck`, and never reach the image.
//
// Keep this in step with docs/harness-protocol/v1/spec.md in the platform
// repo. The wire rules encoded below are the ones a hand-written harness gets
// wrong most often: a terminal event must be the last thing on the stream, a
// disconnect must not take the process down, and /state must answer 404 when
// there is nothing stored rather than erroring.

export type ScaffoldFile = { path: string; content: string; mode?: number }

const SERVER_TS = `// An Orca harness: the platform boots this image per session and drives it
// over Orca Harness Protocol v1.
//
// Everything the protocol requires is here. Your agent goes in runAgent()
// below; the rest is the contract.

import http from 'node:http'

const PORT = Number(process.env.PORT || 7099)

// Names this implementation in /health. Not the protocol name.
const RUNTIME = 'my-harness'

// Stable for the process lifetime, different per replica, so the platform can
// tell instances apart.
const INSTANCE_ID = \`\${RUNTIME}-\${process.pid}-\${Math.random().toString(36).slice(2, 8)}\`

// ---------------------------------------------------------------------------
// The protocol, as types
// ---------------------------------------------------------------------------

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

/** The complete v1 event vocabulary. Anything else is treated as progress. */
export type HarnessEvent =
  | { type: 'progress'; message: string }
  | { type: 'assistant'; message: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input?: unknown }
  | { type: 'tool_result'; toolCallId: string; output?: unknown; isError?: boolean }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'session'; runtimeSessionId: string }
  | { type: 'result'; message: string }
  | { type: 'error'; message: string }

type Emit = (event: HarnessEvent) => void

// ---------------------------------------------------------------------------
// Your agent
// ---------------------------------------------------------------------------

// runAgent is the only function you need to change.
//
//   body   the /run envelope
//   emit   send one event. Call it as often as you like with 'progress' or
//          'assistant'; the caller emits the single terminal event.
//   signal aborts when the platform cancels the run by closing the connection.
//          Thread it into your model and tool calls or you will keep spending
//          tokens on an answer nobody will read.
//
// Return the final answer.
async function runAgent(
  { body, emit, signal }: { body: RunRequest; emit: Emit; signal: AbortSignal },
): Promise<string> {
  const prompt = body.subtask?.prompt ?? ''

  emit({ type: 'progress', message: 'thinking' })

  // Replace everything from here to the return with your agent loop.
  //
  // The platform tools granted to this profile are at body.sessionMcpUrl, an
  // MCP endpoint scoped to this session.
  if (signal.aborted) throw new Error('cancelled')

  return \`echo: \${prompt}\`
}

// ---------------------------------------------------------------------------
// The protocol. You should not need to change anything below.
// ---------------------------------------------------------------------------

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
  const emit: Emit = (event) => {
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

const DOCKERFILE = `# Node runs TypeScript directly by stripping types, so there is no build
# stage and nothing to install: the image is the base plus one source file.
# That also keeps the pull small, which is user-visible latency because the
# substrate pulls this before the first run of a session.
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
COPY package.json ./
COPY server.ts ./

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

const PACKAGE_JSON = `{
  "name": "my-harness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.18"
  },
  "scripts": {
    "start": "node server.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0"
  }
}
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

    // Node strips types rather than compiling them, so this file is only ever
    // type-checked, never emitted.
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

const README_MD = `# my-harness

An Orca harness: a service Orca boots per session and drives over Orca Harness
Protocol v1. Bring any framework, any model.

Your agent goes in \`runAgent()\` in \`server.ts\`. Everything else in that file
is the protocol, and the comments there say what each rule is for. The
\`RunRequest\` and \`HarnessEvent\` types above it are the wire contract, so an
event your editor accepts is an event the platform understands.

## Run it

\`\`\`bash
npm start                      # node runs the TypeScript directly
curl localhost:7099/health

curl -sN localhost:7099/run -H 'content-type: application/json' -d '{
  "sessionId":"s1",
  "profile":{"name":"dev","runtime":"custom"},
  "subtask":{"id":"r1","sessionId":"s1","prompt":"hello"}
}'
\`\`\`

The second command should stream newline-delimited JSON ending in a single
\`result\` event.

There is no build step: Node strips the types and runs the file. Nothing needs
installing to start the server. \`npm install\` only adds the compiler and the
Node types, which is what makes \`npm run typecheck\` and editor completion work.

Two rules are easy to get wrong once you start editing: a client disconnecting
mid-run must not take the process down, and \`GET /state/<id>\` must answer 404
rather than erroring when nothing is stored.

## Ship it

\`\`\`bash
orca harness deploy my-harness . --image ghcr.io/<org>/my-harness
\`\`\`

That builds for linux/amd64, pushes, imports the resulting digest as a new
template version, waits for it to be ready, and activates it.

Your image must be pullable without credentials: the platform mirrors it into
its own registry and cannot authenticate to a private source registry yet. On
GitHub Container Registry a new package is private by default.
`

export const SCAFFOLD_FILES: ScaffoldFile[] = [
  { path: 'server.ts', content: SERVER_TS },
  { path: 'package.json', content: PACKAGE_JSON },
  { path: 'tsconfig.json', content: TSCONFIG_JSON },
  { path: 'Dockerfile', content: DOCKERFILE },
  { path: '.dockerignore', content: DOCKERIGNORE },
  { path: 'README.md', content: README_MD },
]
