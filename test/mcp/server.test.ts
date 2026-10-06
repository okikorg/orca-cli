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
import { AGENT_ID, SESSION_ID, orgKeyRoutes, session } from '../helpers/session-events.js'

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
        // sessions and chat
        'list_sessions',
        'get_session',
        'create_session',
        'list_session_items',
        'delete_session',
        'chat',
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
        // publish
        'publish_agent',
        'list_published_keys',
      ].sort(),
    )
    // The old orca://openapi resource is gone: /api/openapi answers 410.
    await expect(client.listResources()).rejects.toThrow()
  })

  it('whoami returns the server\'s identity plus the context', async () => {
    stubFetch({
      'GET /api/whoami': jsonResponse({ object: 'whoami', tenant: 'org_1', actor: 'key_1', role: 'admin', agent: null }),
    })
    const client = await connect()
    const payload = JSON.parse(firstText(await client.callTool({ name: 'whoami', arguments: {} })))
    expect(payload).toMatchObject({ tenant: 'org_1', role: 'admin', context: 'default', apiUrl: 'http://test:8080' })
  })

  it('chat starts a session with the message and returns the reply once the turn ends', async () => {
    const turn = { id: 'turn_1', status: 'completed', error: null, usage: { input_tokens: 12, output_tokens: 3 } }
    const calls = stubFetch({
      ...orgKeyRoutes(),
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
      ...orgKeyRoutes(),
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(session('completed', { usage: { input_tokens: 12, output_tokens: 3 } })),
      [`GET /api/usage?start=0&session=${SESSION_ID}&group_by=model`]: jsonResponse(summary),
    })
    const client = await connect()
    const payload = JSON.parse(firstText(await client.callTool({ name: 'get_session', arguments: { id: SESSION_ID } })))
    expect(payload).toMatchObject({ id: SESSION_ID, status: 'completed', usage: summary })
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
      const whoami = { object: 'whoami', tenant: 'org_1', actor: 'key_1', role: 'admin', agent: null }
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
      const calls = stubFetch({ 'GET /api/public/kits/kit-AbCdEfGhIjKlMnOpQ': jsonResponse({ object: 'kit.public', public_id: 'kit-AbCdEfGhIjKlMnOpQ' }) })
      const client = await connect(makeClientSource({}))
      const res = await client.callTool({ name: 'show_kit', arguments: { publicId: 'kit-AbCdEfGhIjKlMnOpQ' } })
      expect((res as ToolText).isError).toBeFalsy()
      expect(calls[0].headers.Authorization).toBeUndefined()
    } finally {
      await tmp.cleanup()
    }
  })
})
