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
  agentRoute,
  artifact,
  bytesRoute,
  hostedSession,
  session,
  sessionModelRoute,
  uploadedFile,
} from '../helpers/session-events.js'

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
        // kits
        'list_kits',
        'make_kit',
        'edit_kit',
        'publish_kit',
        'withdraw_kit',
        'show_kit',
        'copy_kit',
      ].sort(),
    )
    // The old orca://openapi resource is gone: /api/openapi answers 410.
    await expect(client.listResources()).rejects.toThrow()
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

  it('make_kit and edit_kit send the author', async () => {
    const kit = { id: 'kit_1', object: 'kit', name: 'Support desk', author: 'Okik Labs' }
    const calls = stubFetch({
      'POST /api/kits': jsonResponse(kit),
      'PATCH /api/kits/kit_1': jsonResponse({ ...kit, author: '' }),
    })
    const client = await connect()
    await client.callTool({ name: 'make_kit', arguments: { name: 'Support desk', author: 'Okik Labs', skills: ['skill_1'] } })
    await client.callTool({ name: 'edit_kit', arguments: { id: 'kit_1', author: '' } })
    expect(calls.map((c) => JSON.parse(c.body ?? '{}'))).toEqual([
      { name: 'Support desk', author: 'Okik Labs', selection: { agents: [], skills: ['skill_1'], templates: [] } },
      { author: '' },
    ])
  })

  it('copy_kit posts the chosen assets', async () => {
    const calls = stubFetch({
      'POST /api/kits/kit-AbCdEfGhIjKlMnOpQ/copy': jsonResponse({ object: 'kit.copy', created: [], credentials: [] }),
    })
    const client = await connect()
    await client.callTool({
      name: 'copy_kit',
      arguments: { publicId: 'kit-AbCdEfGhIjKlMnOpQ', assets: [{ key: 'agent-1', name: 'support' }] },
    })
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ assets: [{ key: 'agent-1', name: 'support' }] })
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
  it('reads a public kit before any login, as orca kits show does', async () => {
    const tmp = await useTmpConfigDir()
    try {
      delete process.env.ORCA_API_KEY
      delete process.env.ORCA_API_URL
      await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080' } } })
      const kit = {
        object: 'kit.public',
        public_id: 'kit-AbCdEfGhIjKlMnOpQ',
        url: 'https://app.example.test/kits/kit-AbCdEfGhIjKlMnOpQ',
        author: 'Okik Labs',
      }
      const calls = stubFetch({ 'GET /api/public/kits/kit-AbCdEfGhIjKlMnOpQ': jsonResponse(kit) })
      const client = await connect(makeClientSource({}))
      const res = await client.callTool({ name: 'show_kit', arguments: { publicId: 'kit-AbCdEfGhIjKlMnOpQ' } })
      expect((res as ToolText).isError).toBeFalsy()
      expect(calls[0].headers.Authorization).toBeUndefined()
      // The author and the share link are the server's, passed through.
      expect(JSON.parse(firstText(res))).toMatchObject({ author: 'Okik Labs', url: kit.url })
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
