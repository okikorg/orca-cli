import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiClient } from '../../src/lib/api.js'
import { CliError, ExitCode } from '../../src/lib/errors.js'
import { buildMcpServer, makeClientSource, type ClientSource } from '../../src/mcp/server.js'
import { saveConfig } from '../../src/lib/config.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'
import { list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import {
  AGENT_ID,
  SESSION_ID,
  TEMPLATE_ID,
  VAULT_ID,
  agent,
  agentRoute,
  artifact,
  bytesRoute,
  hostedSession,
  sandboxView,
  session,
  sessionModelRoute,
  template,
  templateByName,
  uploadedFile,
  vault,
  vaultByName,
  vaultRoute,
} from '../helpers/session-events.js'
import type { RouteHandler } from '../helpers/fetch-mock.js'

// connect builds the server against a ClientSource and returns a connected
// MCP client over an in-memory transport pair: the same wire protocol a
// coding agent speaks over stdio, minus the process boundary.
async function connect(source?: ClientSource): Promise<Client> {
  const getClient: ClientSource =
    source ?? (async () => new ApiClient({ apiUrl: 'http://test:8080', apiKey: 'orca_sk_x', contextName: 'default' }))
  const server = buildMcpServer(getClient)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

type ToolText = { content: Array<{ type: string; text: string }>; isError?: boolean }

function firstText(res: unknown): string {
  return (res as ToolText).content[0]?.text ?? ''
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('orca mcp serve', () => {
  it('exposes one tool per kept command action and no resources', async () => {
    const client = await connect()
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(
      [
        // auth whoami
        'whoami',
        // keys
        'list_keys',
        'create_key',
        'revoke_key',
        // agents
        'list_agents',
        'get_agent',
        'create_agent',
        'update_agent',
        'delete_agent',
        // models
        'list_models',
        // sessions and chat
        'list_sessions',
        'get_session',
        'create_session',
        'list_session_items',
        'sleep_session',
        'delete_session',
        'chat',
        // artifacts
        'list_artifacts',
        'download_artifact',
        // skills
        'list_skills',
        'get_skill',
        'create_skill',
        'delete_skill',
        // vaults
        'list_vaults',
        'create_vault',
        'delete_vault',
        'list_credentials',
        'add_credential',
        'delete_credential',
        // files
        'list_files',
        'upload_file',
        'download_file',
        'delete_file',
        // usage and billing
        'get_usage',
        'list_usage_events',
        'get_wallet',
        'billing_checkout',
        'billing_portal',
        // kits: Orca publishes them, so only show and copy
        'show_kit',
        'copy_kit',
      ].sort(),
    )
    // The old orca://openapi resource is gone: /api/openapi answers 410.
    await expect(client.listResources()).rejects.toThrow()
  })

  it('gives chat, create_session and add_credential these fields', async () => {
    const client = await connect()
    const fields = Object.fromEntries(
      (await client.listTools()).tools
        .filter((t) => ['chat', 'create_session', 'add_credential'].includes(t.name))
        .map((t) => [t.name, { all: Object.keys(t.inputSchema.properties ?? {}), required: t.inputSchema.required ?? [] }]),
    )
    expect(fields).toEqual({
      create_session: { all: ['agent', 'sandbox', 'template', 'vaults', 'files'], required: ['agent'] },
      chat: {
        all: ['message', 'agent', 'session', 'sandbox', 'template', 'vaults', 'timeoutSeconds', 'files'],
        required: ['message'],
      },
      add_credential: {
        all: ['vault', 'name', 'server', 'type', 'token', 'login', 'password'],
        required: ['vault', 'name', 'server'],
      },
    })
  })

  it('names a kit\'s vault in chat\'s description, and no template', async () => {
    const client = await connect()
    const tool = (await client.listTools()).tools.find((t) => t.name === 'chat')
    expect(tool?.description).toContain('such as vaults: ["dataforseo"]')
    expect(tool?.description).not.toContain('seo-helper')
  })

  it('whoami returns the server\'s identity plus the context', async () => {
    stubFetch({
      'GET /api/whoami': jsonResponse({ object: 'whoami', tenant: 'org_1', actor: 'key_1', role: 'admin' }),
    })
    const client = await connect()
    const payload = JSON.parse(firstText(await client.callTool({ name: 'whoami', arguments: {} })))
    expect(payload).toMatchObject({ tenant: 'org_1', role: 'admin', context: 'default', apiUrl: 'http://test:8080' })
  })

  it('chat starts a session with the message and returns the reply once the turn ends', async () => {
    const turn = { id: 'turn_1', status: 'completed', error: null, usage: { input_tokens: 12, output_tokens: 3 } }
    const calls = stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session('in_progress')),
      [`GET /v1/agents/sessions/${SESSION_ID}/turns?limit=1`]: jsonResponse(list([turn])),
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=50&order=desc`]: jsonResponse(
        list([
          { id: 'msg_2', type: 'message', role: 'assistant', turn_id: 'turn_1', content: [{ type: 'output_text', text: 'Done.' }] },
          { id: null, type: 'message', role: 'user', turn_id: 'turn_1', content: [{ type: 'input_text', text: 'triage' }] },
        ]),
      ),
    })
    const client = await connect()
    const res = await client.callTool({ name: 'chat', arguments: { agent: AGENT_ID, message: 'triage' } })
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'none' },
      input: 'triage',
    })
    const reply = JSON.parse(firstText(res))
    expect(reply).toMatchObject({ sessionId: SESSION_ID, done: true, status: 'completed', reply: 'Done.' })
    // Per-turn token figures are not shown (decision 0017); get_session has the session's.
    expect(reply).not.toHaveProperty('usage')
  })

  // chatReply runs `chat` against a turn whose one assistant message is text.
  async function chatReply(text: string): Promise<string> {
    const turn = { id: 'turn_1', status: 'completed', error: null }
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session('in_progress')),
      [`GET /v1/agents/sessions/${SESSION_ID}/turns?limit=1`]: jsonResponse(list([turn])),
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=50&order=desc`]: jsonResponse(
        list([{ id: 'msg_2', type: 'message', role: 'assistant', turn_id: 'turn_1', content: [{ type: 'output_text', text }] }]),
      ),
    })
    const client = await connect()
    const res = await client.callTool({ name: 'chat', arguments: { agent: AGENT_ID, message: 'check the deal' } })
    return JSON.parse(firstText(res)).reply
  }

  it('chat keeps a reply\'s line breaks and indentation', async () => {
    const text = [
      '| Line | Margin |',
      '| --- | --- |',
      '| Freight | 12% |',
      '',
      '1. Check the quote.',
      '2. Flag the gap:',
      '   - freight under 15%',
      '\tthen ask.',
    ].join('\n')
    expect(await chatReply(text)).toBe(text)
  })

  it('chat still strips ANSI escapes from a reply', async () => {
    expect(await chatReply('\x1b[31mred\x1b[0m\n\x1b]0;title\x07done')).toBe('red\ndone')
  })

  it('get_session answers with its usage from /api/usage, not the session object\'s', async () => {
    const summary = { object: 'usage.summary', start: 0, end: 1, session_id: SESSION_ID, cost_micro_usd: 47, meters: [], daily: [], groups: [] }
    stubFetch({
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(session('completed', { usage: { input_tokens: 12, output_tokens: 3 } })),
      [`GET /api/usage?start=0&session=${SESSION_ID}&group_by=model`]: jsonResponse(summary),
      ...sessionModelRoute(),
    })
    const client = await connect()
    const payload = JSON.parse(firstText(await client.callTool({ name: 'get_session', arguments: { id: SESSION_ID } })))
    expect(payload).toMatchObject({ id: SESSION_ID, status: 'completed', usage: summary })
  })

  it('get_session adds where the sandbox is, and leaves it out when the server cannot say', async () => {
    const summary = { object: 'usage.summary', start: 0, end: 1, session_id: SESSION_ID, cost_micro_usd: 0, meters: [], daily: [], groups: [] }
    const routes = {
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(hostedSession()),
      [`GET /api/usage?start=0&session=${SESSION_ID}&group_by=model`]: jsonResponse(summary),
      ...sessionModelRoute(),
    }
    stubFetch({ ...routes, [`GET /api/sessions/${SESSION_ID}/sandbox`]: jsonResponse(sandboxView('waking')) })
    const client = await connect()
    const payload = JSON.parse(firstText(await client.callTool({ name: 'get_session', arguments: { id: SESSION_ID } })))
    expect(payload).toMatchObject({ id: SESSION_ID, sandbox: 'waking' })
    stubFetch({ ...routes, [`GET /api/sessions/${SESSION_ID}/sandbox`]: jsonResponse({ error: { message: 'not found' } }, { status: 404 }) })
    const older = JSON.parse(firstText(await client.callTool({ name: 'get_session', arguments: { id: SESSION_ID } })))
    expect(older).toMatchObject({ id: SESSION_ID, status: 'idle' })
    expect(older).not.toHaveProperty('sandbox')
  })

  describe('sleep_session', () => {
    const SANDBOX = `/api/sessions/${SESSION_ID}/sandbox`

    // callOnFakeClock calls one tool on a fake clock, stepping it a second at
    // a time, so the sleep's polls and its 60-second limit stay fast.
    async function callOnFakeClock(client: Client, args: Record<string, unknown>): Promise<unknown> {
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
      try {
        let settled = false
        const done = client.callTool({ name: 'sleep_session', arguments: args }).finally(() => {
          settled = true
        })
        while (!settled) await vi.advanceTimersByTimeAsync(1000)
        return await done
      } finally {
        vi.useRealTimers()
      }
    }

    it('waits until the sandbox is asleep and returns the view', async () => {
      const asleep = sandboxView('asleep', { outcome: 'asleep', finished_at: 1_783_245_609 })
      let polls = 0
      const calls = stubFetch({
        [`POST ${SANDBOX}/sleep`]: jsonResponse(sandboxView('going_to_sleep', {}), { status: 202 }),
        [`GET ${SANDBOX}`]: (call) => jsonResponse(++polls < 3 ? sandboxView('going_to_sleep', {}) : asleep)(call),
      })
      const client = await connect()
      const res = await callOnFakeClock(client, { id: SESSION_ID })
      expect((res as ToolText).isError).toBeFalsy()
      expect(JSON.parse(firstText(res))).toEqual(asleep)
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3)
    })

    it('returns a sleep that left the sandbox awake with its message', async () => {
      const message = 'The sandbox stayed awake: a message or a file request reached it before it was asleep.'
      stubFetch({
        [`POST ${SANDBOX}/sleep`]: jsonResponse(sandboxView('going_to_sleep', {}), { status: 202 }),
        [`GET ${SANDBOX}`]: jsonResponse(sandboxView('awake', { outcome: 'interrupted', message })),
      })
      const client = await connect()
      const res = await callOnFakeClock(client, { id: SESSION_ID })
      expect(JSON.parse(firstText(res))).toMatchObject({ state: 'awake', last_sleep: { outcome: 'interrupted', message } })
    })

    it('stops waiting inside the 60 seconds, still going to sleep', async () => {
      const calls = stubFetch({
        [`POST ${SANDBOX}/sleep`]: jsonResponse(sandboxView('going_to_sleep', {}), { status: 202 }),
        [`GET ${SANDBOX}`]: jsonResponse(sandboxView('going_to_sleep', {})),
      })
      const client = await connect()
      const res = await callOnFakeClock(client, { id: SESSION_ID })
      expect(JSON.parse(firstText(res))).toMatchObject({ state: 'going_to_sleep' })
      const polls = calls.filter((c) => c.method === 'GET').length
      // A poll a second from 1 to 55 seconds in, so the answer beats the
      // client's 60-second request timeout.
      expect(polls).toBeGreaterThanOrEqual(54)
      expect(polls).toBeLessThanOrEqual(56)
    })

    it('answers at once for no sandbox', async () => {
      const calls = stubFetch({ [`POST ${SANDBOX}/sleep`]: jsonResponse(sandboxView('none')) })
      const client = await connect()
      const res = await client.callTool({ name: 'sleep_session', arguments: { id: SESSION_ID } })
      expect(JSON.parse(firstText(res))).toMatchObject({ state: 'none', environment_id: null })
      expect(calls).toHaveLength(1)
    })

    it('is an error with the server\'s message while a turn runs', async () => {
      const message = 'A turn is running; put the sandbox to sleep once it ends.'
      stubFetch({
        [`POST ${SANDBOX}/sleep`]: jsonResponse({ error: { message, type: 'conflict', param: null, code: 'conflict' } }, { status: 409 }),
      })
      const client = await connect()
      const res = (await client.callTool({ name: 'sleep_session', arguments: { id: SESSION_ID } })) as ToolText
      expect(res.isError).toBe(true)
      expect(firstText(res)).toBe(message)
    })
  })

  it('copy_kit sends the version show_kit returned and the chosen assets', async () => {
    const calls = stubFetch({
      'POST /api/kits/kit-AbCdEfGhIjKlMnOpQ/copy': jsonResponse({ object: 'kit.copy', created: [], credentials: [] }),
    })
    const client = await connect()
    await client.callTool({
      name: 'copy_kit',
      arguments: { publicId: 'kit-AbCdEfGhIjKlMnOpQ', version: 3, assets: [{ key: 'agent-1', name: 'support' }] },
    })
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ version: 3, assets: [{ key: 'agent-1', name: 'support' }] })
  })

  it('copy_kit requires the version, and says to copy only after the person\'s yes', async () => {
    const client = await connect()
    const copyKit = (await client.listTools()).tools.find((t) => t.name === 'copy_kit')
    expect(copyKit?.inputSchema.required).toEqual(['publicId', 'version', 'assets'])
    expect(copyKit?.description).toBe(
      'Copy one of Orca\'s kits into this organization, at the version show_kit returned. Show the person the review from show_kit first, and copy only after they say yes.',
    )
    const calls = stubFetch({})
    const res = await client.callTool({
      name: 'copy_kit',
      arguments: { publicId: 'kit-AbCdEfGhIjKlMnOpQ', assets: [{ key: 'agent-1', name: 'support' }] },
    })
    expect((res as ToolText).isError).toBe(true)
    expect(firstText(res)).toContain('version')
    expect(calls).toHaveLength(0)
  })

  it('copy_kit reports kit_changed and copies nothing', async () => {
    stubFetch({
      'POST /api/kits/kit-AbCdEfGhIjKlMnOpQ/copy': jsonResponse(
        {
          error: {
            message: 'This kit has a newer version (4). Review it again before copying.',
            code: 'kit_changed',
            current_version: 4,
          },
        },
        { status: 409 },
      ),
    })
    const client = await connect()
    const res = await client.callTool({
      name: 'copy_kit',
      arguments: { publicId: 'kit-AbCdEfGhIjKlMnOpQ', version: 3, assets: [{ key: 'agent-1', name: 'support' }] },
    })
    expect((res as ToolText).isError).toBe(true)
    expect(firstText(res)).toContain('This kit has a newer version (4). Review it again before copying.')
  })

  it('reports the login fix when no credential is configured', async () => {
    const client = await connect(async () => {
      throw new CliError('not logged in to Orca.', ExitCode.Auth, ['Run: orca auth login'])
    })
    const res = await client.callTool({ name: 'list_agents', arguments: {} })
    expect((res as ToolText).isError).toBe(true)
    expect(firstText(res)).toContain('orca auth login')
  })

  it('maps a 401 from /v1 to the login fix', async () => {
    stubFetch({
      'GET /v1/agents?limit=20': jsonResponse({ error: { message: 'Invalid API key' } }, { status: 401 }),
    })
    const client = await connect()
    const res = await client.callTool({ name: 'list_agents', arguments: {} })
    expect((res as ToolText).isError).toBe(true)
    expect(firstText(res)).toContain('orca auth login')
  })
})

describe('the MCP server\'s credentials', () => {
  it('follows a new login without a restart', async () => {
    const tmp = await useTmpConfigDir()
    try {
      delete process.env.ORCA_API_KEY
      delete process.env.ORCA_API_URL
      const whoami = { object: 'whoami', tenant: 'org_1', actor: 'key_1', role: 'admin' }
      await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080', apiKey: 'orca_sk_first' } } })
      const calls = stubFetch({ 'GET /api/whoami': jsonResponse(whoami) })
      const client = await connect(makeClientSource({}))
      await client.callTool({ name: 'whoami', arguments: {} })
      await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080', apiKey: 'orca_sk_second' } } })
      await client.callTool({ name: 'whoami', arguments: {} })
      expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer orca_sk_first', 'Bearer orca_sk_second'])
    } finally {
      await tmp.cleanup()
    }
  })
})

describe('show_kit', () => {
  it('returns the review before any login, as orca kits show prints it', async () => {
    const tmp = await useTmpConfigDir()
    try {
      delete process.env.ORCA_API_KEY
      delete process.env.ORCA_API_URL
      await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080' } } })
      const review = {
        object: 'kit.review',
        public_id: 'kit-AbCdEfGhIjKlMnOpQ',
        version: 3,
        publisher: { orca: true },
        summary: { runs_code: ['No code: instructions and tools only'], reaches: [], spends: ['Every run is paid from your organization\'s credit'] },
      }
      const calls = stubFetch({ 'GET /api/public/kits/kit-AbCdEfGhIjKlMnOpQ/review': jsonResponse(review) })
      const client = await connect(makeClientSource({}))
      const res = await client.callTool({ name: 'show_kit', arguments: { publicId: 'kit-AbCdEfGhIjKlMnOpQ' } })
      expect((res as ToolText).isError).toBeFalsy()
      expect(calls[0].headers.Authorization).toBeUndefined()
      // The version and the summaries are the server's, passed through.
      expect(JSON.parse(firstText(res))).toEqual(review)
    } finally {
      await tmp.cleanup()
    }
  })
})

describe('orca mcp serve: models, artifacts and staged files', () => {
  const MODELS = {
    object: 'list',
    openrouter_fee_bps: 550,
    groups: [
      {
        payer: 'orca_credit',
        provider: 'openrouter',
        label: 'Orca credit',
        available: true,
        models: [{ id: 'orca/openrouter/openai/gpt-5.6-luna', input_micro_usd_per_million: 200_000, output_micro_usd_per_million: 1_200_000 }],
      },
      { payer: 'own_key', provider: 'anthropic', label: 'Anthropic', available: true, models: [{ id: 'anthropic/claude-sonnet-4-5' }] },
    ],
  }
  const ARTIFACTS = `/v1/agents/sessions/${SESSION_ID}/artifacts`

  it('list_models pages flat rows, narrowed by payer and query', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(MODELS) })
    const client = await connect()
    const all = JSON.parse(firstText(await client.callTool({ name: 'list_models', arguments: {} })))
    expect(all).toEqual({
      openrouter_fee_bps: 550,
      items: [
        { id: 'orca/openrouter/openai/gpt-5.6-luna', payer: 'orca', input_micro_usd_per_million: 200_000, output_micro_usd_per_million: 1_200_000 },
        { id: 'anthropic/claude-sonnet-4-5', payer: 'anthropic' },
      ],
      hasMore: false,
      lastId: 'anthropic/claude-sonnet-4-5',
    })
    const first = JSON.parse(firstText(await client.callTool({ name: 'list_models', arguments: { limit: 1 } })))
    expect(first).toMatchObject({ hasMore: true, lastId: 'orca/openrouter/openai/gpt-5.6-luna' })
    const next = JSON.parse(firstText(await client.callTool({ name: 'list_models', arguments: { limit: 1, after: first.lastId } })))
    expect(next.items.map((m: { id: string }) => m.id)).toEqual(['anthropic/claude-sonnet-4-5'])
    const narrowed = JSON.parse(firstText(await client.callTool({ name: 'list_models', arguments: { payer: 'anthropic' } })))
    expect(narrowed.items.map((m: { id: string }) => m.id)).toEqual(['anthropic/claude-sonnet-4-5'])
    const searched = JSON.parse(firstText(await client.callTool({ name: 'list_models', arguments: { query: 'LUNA' } })))
    expect(searched.items.map((m: { id: string }) => m.id)).toEqual(['orca/openrouter/openai/gpt-5.6-luna'])
    const unknown = (await client.callTool({ name: 'list_models', arguments: { payer: 'openai' } })) as ToolText
    expect(unknown.isError).toBe(true)
    expect(firstText(unknown)).toContain('Payers: orca, anthropic')
  })

  it('list_artifacts returns a page of the session\'s artifacts', async () => {
    stubFetch({
      [`GET ${ARTIFACTS}?limit=20`]: jsonResponse(list([artifact('art_2', '/workspace/outputs/primes.txt', 'turn_2')])),
    })
    const client = await connect()
    const payload = JSON.parse(firstText(await client.callTool({ name: 'list_artifacts', arguments: { session: SESSION_ID } })))
    expect(payload.items.map((a: { path: string }) => a.path)).toEqual(['/workspace/outputs/primes.txt'])
  })

  it('download_artifact saves one into a folder under its own name, and all of the newest turn', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orca-mcp-'))
    stubFetch({
      [`GET ${ARTIFACTS}/art_2`]: jsonResponse(artifact('art_2', '/workspace/outputs/../primes.txt', 'turn_2')),
      [`GET ${ARTIFACTS}/art_2/content`]: bytesRoute([1, 2, 3, 4, 5]),
      [`GET ${ARTIFACTS}?limit=100&order=desc`]: jsonResponse(
        list([artifact('art_2', '/workspace/outputs/primes.txt', 'turn_2'), artifact('art_1', '/workspace/outputs/old.txt', 'turn_1')]),
      ),
    })
    const client = await connect()
    const one = JSON.parse(
      firstText(await client.callTool({ name: 'download_artifact', arguments: { session: SESSION_ID, artifact: 'art_2', path: dir } })),
    )
    expect(one).toEqual({ id: 'art_2', path: path.join(dir, 'primes.txt'), bytes: 5 })
    expect(await readFile(path.join(dir, 'primes.txt'))).toEqual(Buffer.from([1, 2, 3, 4, 5]))

    const into = path.join(dir, 'all')
    const all = JSON.parse(
      firstText(await client.callTool({ name: 'download_artifact', arguments: { session: SESSION_ID, all: true, path: into } })),
    )
    expect(all.map((a: { id: string }) => a.id)).toEqual(['art_2'])
    expect(await readdir(into)).toEqual(['primes.txt'])

    const neither = (await client.callTool({ name: 'download_artifact', arguments: { session: SESSION_ID, path: dir } })) as ToolText
    expect(neither.isError).toBe(true)
  })

  it('create_session uploads files and creates a sandbox with them by file_id', async () => {
    const local = path.join(await mkdtemp(path.join(os.tmpdir(), 'orca-mcp-')), 'data.csv')
    await writeFile(local, 'a,b\n')
    const calls = stubFetch({
      ...agentRoute(),
      'POST /v1/files': jsonResponse(uploadedFile('file_1', 'data.csv')),
      'POST /v1/agents/sessions': jsonResponse(hostedSession()),
    })
    const client = await connect()
    const res = (await client.callTool({
      name: 'create_session',
      arguments: { agent: AGENT_ID, files: [{ path: local }] },
    })) as ToolText
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted', files: [{ type: 'file_id', file_id: 'file_1', path: '/workspace/data.csv' }] },
    })
  })

  it('chat stages files into the session it continues before sending', async () => {
    const local = path.join(await mkdtemp(path.join(os.tmpdir(), 'orca-mcp-')), 'data.csv')
    await writeFile(local, 'a,b\n')
    const turn = { id: 'turn_2', status: 'completed', error: null }
    let turnsListed = 0
    const calls = stubFetch({
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(hostedSession()),
      'POST /v1/files': jsonResponse(uploadedFile('file_1', 'data.csv')),
      'POST /v1/agents/environments/env_1/files': jsonResponse({ environment_id: 'env_1', object: 'agent.environment.file', path: '/workspace/data.csv', size_bytes: 4 }),
      [`GET /v1/agents/sessions/${SESSION_ID}/turns?limit=1`]: () =>
        jsonResponse(list(turnsListed++ === 0 ? [] : [turn]))({} as never),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: () => new Response(null, { status: 204 }),
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=50&order=desc`]: jsonResponse(
        list([{ id: 'msg_2', type: 'message', role: 'assistant', turn_id: 'turn_2', content: [{ type: 'output_text', text: 'Read it.' }] }]),
      ),
    })
    const client = await connect()
    const payload = JSON.parse(
      firstText(
        await client.callTool({ name: 'chat', arguments: { session: SESSION_ID, message: 'read /workspace/data.csv', files: [{ path: local }] } }),
      ),
    )
    expect(payload).toMatchObject({ done: true, reply: 'Read it.' })
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(posts).toEqual(['/v1/files', '/v1/agents/environments/env_1/files', `/v1/agents/sessions/${SESSION_ID}/events`])
  })
})

describe('orca mcp serve: chat starts a session with a sandbox, a template and vaults', () => {
  const DIGEST = '/workspace/site-digest.md'
  const digest = async () => {
    const local = path.join(await mkdtemp(path.join(os.tmpdir(), 'orca-mcp-')), 'site-digest.md')
    await writeFile(local, '# Posts\n')
    return local
  }

  // newSessionTurn is everything one chat on a new session calls after its
  // lookups: the upload, the create, a template's staging, then the message
  // as an event and its turn. It returns the recorded calls.
  function newSessionTurn(lookups: Record<string, RouteHandler>, created: Record<string, unknown>) {
    const turn = { id: 'turn_1', status: 'completed', error: null }
    let turnsListed = 0
    return stubFetch({
      ...agentRoute(),
      ...lookups,
      'POST /v1/files': jsonResponse(uploadedFile('file_1', 'site-digest.md')),
      'POST /v1/agents/sessions': jsonResponse(created),
      'POST /v1/agents/environments/env_1/files': jsonResponse({ environment_id: 'env_1', object: 'agent.environment.file', path: DIGEST, size_bytes: 8 }),
      [`GET /v1/agents/sessions/${SESSION_ID}/turns?limit=1`]: () => jsonResponse(list(turnsListed++ === 0 ? [] : [turn]))({} as never),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: () => new Response(null, { status: 204 }),
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=50&order=desc`]: jsonResponse(
        list([{ id: 'msg_2', type: 'message', role: 'assistant', turn_id: 'turn_1', content: [{ type: 'output_text', text: '5 topics.' }] }]),
      ),
    })
  }

  const templateLookup = templateByName('seo-helper', [template('envtmpl_other', 'other'), template()])
  const vaultLookup = vaultByName('dataforseo', [vault()])
  const staged = { type: 'file_id', file_id: 'file_1', path: DIGEST }

  const cases: {
    name: string
    args: Record<string, unknown>
    lookups: Record<string, RouteHandler>
    created: Record<string, unknown>
    body: Record<string, unknown>
    // Staged after the create, through the environment (a template's).
    after?: boolean
  }[] = [
    {
      name: 'sandbox',
      args: { sandbox: true },
      lookups: {},
      created: hostedSession(),
      body: { environment: { type: 'openai_hosted' } },
    },
    {
      name: 'sandbox with files',
      args: { sandbox: true, files: true },
      lookups: {},
      created: hostedSession(),
      body: { environment: { type: 'openai_hosted', files: [staged] } },
    },
    {
      name: 'template by name',
      args: { template: 'seo-helper' },
      lookups: templateLookup,
      created: hostedSession(),
      body: { environment: { type: 'openai_hosted', environment_template_id: TEMPLATE_ID } },
    },
    {
      name: 'template with files, staged after the create',
      args: { template: 'seo-helper', files: true },
      lookups: templateLookup,
      created: hostedSession(),
      body: { environment: { type: 'openai_hosted', environment_template_id: TEMPLATE_ID } },
      after: true,
    },
    {
      name: 'vaults by name',
      args: { vaults: ['dataforseo'] },
      lookups: vaultLookup,
      created: session(),
      body: { environment: { type: 'none' }, vault_ids: [VAULT_ID] },
    },
    {
      name: 'vaults by id, with files',
      args: { vaults: [VAULT_ID], files: true },
      lookups: vaultRoute(),
      created: hostedSession(),
      body: { environment: { type: 'openai_hosted', files: [staged] }, vault_ids: [VAULT_ID] },
    },
    {
      name: 'template, vaults and files, as the seo-helper kit starts',
      args: { template: 'seo-helper', vaults: ['dataforseo'], files: true },
      lookups: { ...templateLookup, ...vaultLookup },
      created: hostedSession(),
      body: { environment: { type: 'openai_hosted', environment_template_id: TEMPLATE_ID }, vault_ids: [VAULT_ID] },
      after: true,
    },
  ]

  for (const c of cases) {
    it(`chat with ${c.name} creates the session, then sends the message`, async () => {
      const { files, ...rest } = c.args
      const args = { agent: AGENT_ID, message: 'Give me the top 5 topics.', ...rest, ...(files ? { files: [{ path: await digest() }] } : {}) }
      const calls = newSessionTurn(c.lookups, c.created)
      const client = await connect()
      const res = (await client.callTool({ name: 'chat', arguments: args })) as ToolText
      expect(res.isError).toBeFalsy()
      expect(JSON.parse(firstText(res))).toMatchObject({ sessionId: SESSION_ID, done: true, reply: '5 topics.' })
      const create = calls.find((call) => call.path === '/v1/agents/sessions')
      expect(JSON.parse(create?.body ?? '{}')).toEqual({ agent_id: AGENT_ID, ...c.body })
      const posts = calls.filter((call) => call.method === 'POST').map((call) => call.path)
      expect(posts).toEqual([
        ...(files ? ['/v1/files'] : []),
        '/v1/agents/sessions',
        ...(c.after ? ['/v1/agents/environments/env_1/files'] : []),
        `/v1/agents/sessions/${SESSION_ID}/events`,
      ])
      if (c.after) {
        expect(JSON.parse(calls.find((call) => call.path === '/v1/agents/environments/env_1/files')?.body ?? '{}')).toEqual(staged)
      }
    })
  }

  it('chat refuses a template two share before anything is uploaded or created, listing both ids', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      ...templateByName('seo-helper', [template('envtmpl_1', 'seo-helper'), template('envtmpl_2', 'seo-helper')]),
    })
    const client = await connect()
    const res = (await client.callTool({
      name: 'chat',
      arguments: { agent: AGENT_ID, template: 'seo-helper', files: [{ path: await digest() }], message: 'hi' },
    })) as ToolText
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain('2 environment templates are named "seo-helper"')
    expect(firstText(res)).toContain('envtmpl_1, envtmpl_2')
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('chat refuses a sandbox, template or vaults for a session it continues', async () => {
    const calls = stubFetch({})
    const client = await connect()
    for (const extra of [{ sandbox: true }, { template: 'seo-helper' }, { vaults: ['dataforseo'] }]) {
      const res = (await client.callTool({ name: 'chat', arguments: { session: SESSION_ID, message: 'more', ...extra } })) as ToolText
      expect(res.isError).toBe(true)
      expect(firstText(res)).toContain('are for a new session')
    }
    expect(calls).toHaveLength(0)
  })

  it('chat that outlasts its wait says to poll get_session and never resend', async () => {
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session('in_progress')),
      [`GET /v1/agents/sessions/${SESSION_ID}/turns?limit=1`]: jsonResponse(list([])),
    })
    const client = await connect()
    const res = await client.callTool({ name: 'chat', arguments: { agent: AGENT_ID, message: 'write it', timeoutSeconds: 1 } })
    const payload = JSON.parse(firstText(res))
    expect(payload).toMatchObject({ sessionId: SESSION_ID, done: false })
    expect(payload.next).toContain('never send the message again')
    expect(payload.next).toContain('get_session')
  })

  it('create_session takes a template and vaults by name too', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      ...templateLookup,
      ...vaultLookup,
      'POST /v1/agents/sessions': jsonResponse(hostedSession()),
    })
    const client = await connect()
    const res = (await client.callTool({
      name: 'create_session',
      arguments: { agent: AGENT_ID, template: 'seo-helper', vaults: ['dataforseo'] },
    })) as ToolText
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(calls.find((call) => call.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted', environment_template_id: TEMPLATE_ID },
      vault_ids: [VAULT_ID],
    })
  })
})

describe('orca mcp serve: add_credential', () => {
  const CREDENTIAL = {
    id: 'cred_1',
    object: 'vault.credential',
    vault_id: VAULT_ID,
    name: 'dataforseo',
    created_at: 1,
    updated_at: 1,
  }
  const SERVER = 'https://mcp.dataforseo.com/mcp'

  it('sends a bearer token through /v1, the default type', async () => {
    const calls = stubFetch({
      ...vaultRoute(),
      [`POST /v1/vaults/${VAULT_ID}/credentials`]: jsonResponse({ ...CREDENTIAL, auth: { type: 'static_bearer', mcp_server_url: SERVER } }),
    })
    const client = await connect()
    for (const type of [undefined, 'static_bearer']) {
      const res = (await client.callTool({
        name: 'add_credential',
        arguments: { vault: VAULT_ID, name: 'dataforseo', server: SERVER, token: 'tok-1', ...(type ? { type } : {}) },
      })) as ToolText
      expect(res.isError).toBeFalsy()
    }
    expect(calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body ?? '{}'))).toEqual([
      { name: 'dataforseo', auth: { type: 'static_bearer', mcp_server_url: SERVER, token: 'tok-1' } },
      { name: 'dataforseo', auth: { type: 'static_bearer', mcp_server_url: SERVER, token: 'tok-1' } },
    ])
  })

  it('sends a login and password through /api for static_basic, and returns neither', async () => {
    const created = { ...CREDENTIAL, auth: { type: 'static_basic', mcp_server_url: SERVER } }
    const calls = stubFetch({ ...vaultRoute(), [`POST /api/vaults/${VAULT_ID}/credentials`]: jsonResponse(created) })
    const client = await connect()
    const res = (await client.callTool({
      name: 'add_credential',
      arguments: { vault: VAULT_ID, name: 'dataforseo', server: SERVER, type: 'static_basic', login: 'seo@acme.dev', password: 'pw-secret' },
    })) as ToolText
    expect(res.isError).toBeFalsy()
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', `/v1/vaults/${VAULT_ID}`],
      ['POST', `/api/vaults/${VAULT_ID}/credentials`],
    ])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({
      name: 'dataforseo',
      auth: { type: 'static_basic', mcp_server_url: SERVER, login: 'seo@acme.dev', password: 'pw-secret' },
    })
    expect(calls[1].headers.Authorization).toBe('Bearer orca_sk_x')
    expect(JSON.parse(firstText(res))).toEqual(created)
    expect(firstText(res)).not.toContain('pw-secret')
  })

  it('refuses fields of the other type, or a missing secret, before any request', async () => {
    const calls = stubFetch({})
    const client = await connect()
    const base = { vault: VAULT_ID, name: 'dataforseo', server: SERVER }
    for (const [args, error] of [
      [{ type: 'static_basic', login: 'seo@acme.dev' }, 'static_basic needs login and password'],
      [{ type: 'static_basic', login: 'seo@acme.dev', password: 'pw', token: 'tok' }, 'token is for static_bearer'],
      [{ token: 'tok', password: 'pw' }, 'login and password are for type static_basic'],
      [{}, 'static_bearer needs token'],
    ] as const) {
      const res = (await client.callTool({ name: 'add_credential', arguments: { ...base, ...args } })) as ToolText
      expect(res.isError).toBe(true)
      expect(firstText(res)).toContain(error)
    }
    expect(calls).toHaveLength(0)
  })

  it('tells the coding agent to prefer the terminal', async () => {
    const client = await connect()
    const tool = (await client.listTools()).tools.find((t) => t.name === 'add_credential')
    expect(tool?.description).toContain('Prefer the terminal')
    expect(tool?.description).toContain('--basic --login <login>')
  })
})

describe('orca mcp serve: vault tools take a vault id or name', () => {
  const SERVER = 'https://mcp.dataforseo.com/mcp'
  const CREDENTIAL = {
    id: 'cred_1',
    object: 'vault.credential',
    vault_id: VAULT_ID,
    name: 'dataforseo',
    auth: { type: 'static_bearer', mcp_server_url: SERVER },
    created_at: 1,
    updated_at: 1,
  }
  const byId = vaultRoute()
  const byName = vaultByName('dataforseo', [vault('vault_other', 'other'), vault()])

  // Each tool's call, the request it makes once the vault is found, and the
  // route that answers it.
  const tools: { name: string; args: (vault: string) => Record<string, unknown>; call: string; route: Record<string, RouteHandler> }[] = [
    {
      name: 'list_credentials',
      args: (v) => ({ vault: v }),
      call: `GET /v1/vaults/${VAULT_ID}/credentials?limit=20`,
      route: { [`GET /v1/vaults/${VAULT_ID}/credentials?limit=20`]: jsonResponse(list([CREDENTIAL])) },
    },
    {
      name: 'add_credential',
      args: (v) => ({ vault: v, name: 'dataforseo', server: SERVER, token: 'tok-1' }),
      call: `POST /v1/vaults/${VAULT_ID}/credentials`,
      route: { [`POST /v1/vaults/${VAULT_ID}/credentials`]: jsonResponse(CREDENTIAL) },
    },
    {
      name: 'add_credential (static_basic)',
      args: (v) => ({ vault: v, name: 'dataforseo', server: SERVER, type: 'static_basic', login: 'seo@acme.dev', password: 'pw' }),
      call: `POST /api/vaults/${VAULT_ID}/credentials`,
      route: { [`POST /api/vaults/${VAULT_ID}/credentials`]: jsonResponse({ ...CREDENTIAL, auth: { type: 'static_basic', mcp_server_url: SERVER } }) },
    },
    {
      name: 'delete_credential',
      args: (v) => ({ vault: v, id: 'cred_1' }),
      call: `DELETE /v1/vaults/${VAULT_ID}/credentials/cred_1`,
      route: { [`DELETE /v1/vaults/${VAULT_ID}/credentials/cred_1`]: jsonResponse({ id: 'cred_1', type: 'vault.credential_deleted' }) },
    },
    {
      name: 'delete_vault',
      args: (v) => ({ id: v }),
      call: `DELETE /v1/vaults/${VAULT_ID}`,
      route: { [`DELETE /v1/vaults/${VAULT_ID}`]: jsonResponse({ id: VAULT_ID, type: 'vault_deleted' }) },
    },
  ]
  const toolName = (name: string) => name.split(' ')[0]

  for (const t of tools) {
    for (const [how, ref, lookup] of [
      ['an id', VAULT_ID, byId],
      ['a name', 'dataforseo', byName],
    ] as const) {
      it(`${t.name} takes the vault by ${how}`, async () => {
        const calls = stubFetch({ ...lookup, ...t.route })
        const client = await connect()
        const res = (await client.callTool({ name: toolName(t.name), arguments: t.args(ref) })) as ToolText
        expect(res.isError).toBeFalsy()
        expect(calls.map((c) => `${c.method} ${c.path}`).at(-1)).toBe(t.call)
      })
    }

    it(`${t.name} says no vault has the name, and changes nothing`, async () => {
      const calls = stubFetch(vaultByName('dataforseo', [vault('vault_other', 'other')]))
      const client = await connect()
      const res = (await client.callTool({ name: toolName(t.name), arguments: t.args('dataforseo') })) as ToolText
      expect(res.isError).toBe(true)
      expect(firstText(res)).toContain('no vault named "dataforseo"')
      expect(firstText(res)).toContain('List vaults with: orca vaults list')
      expect(calls.filter((c) => c.path.includes('/credentials') || c.method !== 'GET')).toHaveLength(0)
    })
  }

  it('refuses a vault name two share, listing both ids', async () => {
    const calls = stubFetch(vaultByName('dataforseo', [vault('vault_1', 'dataforseo'), vault('vault_2', 'dataforseo')]))
    const client = await connect()
    for (const t of tools) {
      const res = (await client.callTool({ name: toolName(t.name), arguments: t.args('dataforseo') })) as ToolText
      expect(res.isError).toBe(true)
      expect(firstText(res)).toContain('2 vaults are named "dataforseo"')
      expect(firstText(res)).toContain('vault_1, vault_2')
    }
    expect(calls.filter((c) => c.path.includes('/credentials') || c.method !== 'GET')).toHaveLength(0)
  })

  it('describes each vault parameter as a vault id or name', async () => {
    const client = await connect()
    const described = Object.fromEntries(
      (await client.listTools()).tools
        .filter((t) => ['list_credentials', 'add_credential', 'delete_credential', 'delete_vault'].includes(t.name))
        .map((t) => {
          const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>
          return [t.name, (props.vault ?? props.id)?.description]
        }),
    )
    expect(described).toEqual({
      list_credentials: 'vault id or name',
      add_credential: 'vault id or name',
      delete_credential: 'vault id or name',
      delete_vault: 'vault id or name',
    })
  })
})

describe('orca mcp serve: list summaries and capped results', () => {
  const MAX = 50_000
  // A realistic body: the Margin Check agent's instructions run to 9 KB.
  const longText = (kb: number, seed: string) => `${seed}: ` + 'Check the freight line against the quote. '.repeat(Math.ceil((kb * 1024) / 43))
  const agentNumber = (n: number) => 'agent_' + String(n).padStart(32, '0')

  async function callJson(client: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) {
    const res = (await client.callTool({ name, arguments: args })) as ToolText
    expect(res.isError).toBeFalsy()
    const text = firstText(res)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX)
    return { text, payload: JSON.parse(text) }
  }

  it('list_agents returns summaries, no instructions, for an organization far over 50 KB', async () => {
    const agents = Array.from({ length: 20 }, (_, i) =>
      agent({
        id: agentNumber(i),
        name: `agent-${i}`,
        instructions: longText(9, `agent ${i}`),
        tools: [{ type: 'mcp', server_label: 'crm' }, { type: 'web_search' }, { type: 'mcp', server_label: 'mail' }],
      }),
    )
    expect(JSON.stringify(agents).length).toBeGreaterThan(150_000)
    stubFetch({ 'GET /v1/agents?limit=20': jsonResponse(list(agents)) })
    const client = await connect()
    const { text, payload } = await callJson(client, 'list_agents', {})
    expect(text).not.toContain('instructions')
    expect(text).not.toContain('Check the freight line')
    expect(payload.items).toHaveLength(20)
    expect(payload.items[0]).toEqual({
      id: agentNumber(0),
      name: 'agent-0',
      model: 'orca/openrouter/openai/gpt-5.6-luna',
      tools: ['mcp', 'web_search'],
      created_at: 1_783_245_600,
    })
    expect(payload).toMatchObject({ hasMore: false, lastId: agentNumber(19) })
  })

  it('list_sessions leaves out the agent snapshot', async () => {
    const snapshot = { id: AGENT_ID, name: 'margin-check', model: 'orca/openrouter/openai/gpt-5.6-luna', instructions: longText(9, 'snapshot'), tools: [] }
    stubFetch({
      'GET /v1/agents/sessions?limit=20': jsonResponse(list([session('idle', { agent: snapshot })])),
    })
    const client = await connect()
    const sessions = await callJson(client, 'list_sessions', {})
    expect(sessions.text).not.toContain('instructions')
    expect(sessions.payload.items[0]).toMatchObject({
      id: SESSION_ID,
      status: 'idle',
      agent: { id: AGENT_ID, name: 'margin-check', model: 'orca/openrouter/openai/gpt-5.6-luna' },
      environment: 'none',
    })
  })

  it('a page over the cap drops items from its end and carries hasMore and the cursor', async () => {
    const message = (i: number) => ({
      id: `msg_${String(i).padStart(2, '0')}`,
      type: 'message',
      role: 'assistant',
      turn_id: 'turn_1',
      content: [{ type: 'output_text', text: longText(8, `reply ${i}`) }],
    })
    const newestFirst = Array.from({ length: 20 }, (_, i) => message(19 - i))
    const calls = stubFetch({
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=20&order=desc`]: jsonResponse(list(newestFirst)),
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=20&after=msg_14&order=desc`]: jsonResponse(list([message(13)])),
    })
    const client = await connect()
    const { payload } = await callJson(client, 'list_session_items', { id: SESSION_ID })
    expect(payload.hasMore).toBe(true)
    expect(payload.items.length).toBeGreaterThan(0)
    expect(payload.items.length).toBeLessThan(20)
    // Whole messages, newest first; the cursor is the last one kept.
    expect(payload.items.map((i: { id: string }) => i.id)).toEqual(newestFirst.slice(0, payload.items.length).map((m) => m.id))
    expect(payload.items[0].text).toBe(longText(8, 'reply 19').trimEnd())
    expect(payload.lastId).toBe(payload.items.at(-1).id)
    expect(payload.truncated).toContain(`pass after: "${payload.lastId}"`)
    // Six 8 KB messages fit in 50 KB; the next page starts after the sixth.
    expect(payload.lastId).toBe('msg_14')
    const next = await callJson(client, 'list_session_items', { id: SESSION_ID, after: payload.lastId })
    expect(next.payload.items.map((i: { id: string }) => i.id)).toEqual(['msg_13'])
    expect(calls.at(-1)?.path).toContain('after=msg_14')
  })

  it('a value over the cap shortens its long strings, marked, and says how to get it whole', async () => {
    const instructions = longText(80, 'margin check')
    stubFetch({ [`GET /v1/agents/${AGENT_ID}`]: jsonResponse(agent({ instructions, metadata: { team: 'sales' } })) })
    const client = await connect()
    const { payload } = await callJson(client, 'get_agent', { agent: AGENT_ID })
    expect(payload).toMatchObject({ id: AGENT_ID, name: 'support', metadata: { team: 'sales' } })
    expect(payload.instructions.startsWith('margin check: Check the freight line')).toBe(true)
    expect(payload.instructions).toMatch(new RegExp(`\\.\\.\\. \\[shortened from ${instructions.length} characters\\]$`))
    expect(payload.shortened).toContain('orca agents get <agent> --json')
  })

  it('chat takes an agent by name with no list call first', async () => {
    const turn = { id: 'turn_1', status: 'completed', error: null }
    const calls = stubFetch({
      'GET /v1/agents/margin-check': jsonResponse({ error: { message: 'No such agent' } }, { status: 404 }),
      'GET /v1/agents?limit=100': jsonResponse(list([agent({ id: agentNumber(7), name: 'other' }), agent({ name: 'margin-check' })])),
      'POST /v1/agents/sessions': jsonResponse(session('in_progress')),
      [`GET /v1/agents/sessions/${SESSION_ID}/turns?limit=1`]: jsonResponse(list([turn])),
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=50&order=desc`]: jsonResponse(
        list([{ id: 'msg_2', type: 'message', role: 'assistant', turn_id: 'turn_1', content: [{ type: 'output_text', text: 'Margin is 18%.' }] }]),
      ),
    })
    const client = await connect()
    const { payload } = await callJson(client, 'chat', { agent: 'margin-check', message: 'check the deal' })
    expect(payload).toMatchObject({ done: true, reply: 'Margin is 18%.' })
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toMatchObject({ agent_id: AGENT_ID })
  })
})
