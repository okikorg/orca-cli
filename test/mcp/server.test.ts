import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiClient } from '../../src/lib/api.js'
import { CliError, ExitCode } from '../../src/lib/errors.js'
import { buildMcpServer, type ClientSource } from '../../src/mcp/server.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { vi } from 'vitest'

// connect builds the server against a ClientSource and returns a connected
// MCP client over an in-memory transport pair - the same wire protocol a
// coding agent speaks over stdio, minus the process boundary.
async function connect(source?: ClientSource): Promise<Client> {
  const getClient: ClientSource =
    source ??
    (async () =>
      new ApiClient({ apiUrl: 'http://test:8080', apiKey: 'ao_test_x', contextName: 'default' }))
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
  it('exposes the curated tool surface and the openapi resource', async () => {
    const client = await connect()
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(
      [
        'whoami',
        'get_usage',
        'list_agents',
        'get_agent',
        'create_agent',
        'update_agent',
        'run_agent',
        'get_run',
        'wait_for_run',
        'list_runs',
        'cancel_run',
        'list_skills',
        'attach_skill',
        'detach_skill',
        'storage_list',
        'storage_read',
        'storage_write',
        'publish_agent',
        'api_request',
      ].sort(),
    )
    const resources = (await client.listResources()).resources.map((r) => r.uri)
    expect(resources).toContain('orca://openapi')
  })

  it('run_agent starts a run and points at wait_for_run', async () => {
    const calls = stubFetch({
      'POST /api/runs': jsonResponse({ runId: 'r1', sessionId: 's1' }),
    })
    const client = await connect()
    const res = await client.callTool({
      name: 'run_agent',
      arguments: { agent: 'support', prompt: 'triage the inbox' },
    })
    const text = firstText(res)
    expect(text).toContain('"runId": "r1"')
    expect(text).toContain('wait_for_run')
    const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>
    expect(body.profile).toBe('support')
    expect(body.title).toBe('triage the inbox')
  })

  it('wait_for_run consumes the SSE stream and reports done with a cursor', async () => {
    const sse =
      'data: {"type":"progress","message":"thinking"}\n\n' +
      'data: {"type":"result","message":"done"}\n\n'
    stubFetch({
      'GET /api/runs/r1/stream': () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      'GET /api/runs/r1': jsonResponse({
        id: 'r1',
        subTask: { profile: 'support', title: 't' },
        status: 'ok',
        startedAt: 'now',
        events: [],
      }),
    })
    const client = await connect()
    const res = await client.callTool({
      name: 'wait_for_run',
      arguments: { runId: 'r1', timeoutSeconds: 5 },
    })
    const payload = JSON.parse(firstText(res)) as {
      status: string
      done: boolean
      events: unknown[]
      nextAfterEvent: number
    }
    expect(payload.status).toBe('ok')
    expect(payload.done).toBe(true)
    expect(payload.events).toHaveLength(2)
    expect(payload.nextAfterEvent).toBe(2)

    // afterEvent skips what the caller already saw.
    const res2 = await client.callTool({
      name: 'wait_for_run',
      arguments: { runId: 'r1', timeoutSeconds: 5, afterEvent: 1 },
    })
    const payload2 = JSON.parse(firstText(res2)) as { events: unknown[]; nextAfterEvent: number }
    expect(payload2.events).toHaveLength(1)
    expect(payload2.nextAfterEvent).toBe(2)
  })

  it('api_request reaches arbitrary endpoints but only under /api/', async () => {
    stubFetch({
      'GET /api/pools?limit=2': jsonResponse([{ name: 'default' }]),
    })
    const client = await connect()

    const ok = await client.callTool({
      name: 'api_request',
      arguments: { method: 'GET', path: '/api/pools', query: { limit: '2' } },
    })
    expect(firstText(ok)).toContain('default')
    expect((ok as ToolText).isError).toBeFalsy()

    const bad = await client.callTool({
      name: 'api_request',
      arguments: { method: 'GET', path: '/healthz' },
    })
    expect((bad as ToolText).isError).toBe(true)
    expect(firstText(bad)).toContain('/api/')
  })

  it('reports the login fix when no credential is configured', async () => {
    const client = await connect(async () => {
      throw new CliError('not logged in to Orca.', ExitCode.Auth, [
        'Run: orca login   (or set ORCA_API_KEY and ORCA_API_URL)',
      ])
    })
    const res = await client.callTool({ name: 'list_agents', arguments: {} })
    expect((res as ToolText).isError).toBe(true)
    expect(firstText(res)).toContain('orca login')
  })

  it('maps a 401 to the login fix', async () => {
    stubFetch({
      'GET /api/profiles?limit=50': jsonResponse({ error: 'bad key' }, { status: 401 }),
    })
    const client = await connect()
    const res = await client.callTool({ name: 'list_agents', arguments: {} })
    expect((res as ToolText).isError).toBe(true)
    expect(firstText(res)).toContain('orca login')
  })

  it('storage_write refuses prefix keys and round-trips content', async () => {
    const calls = stubFetch({
      'PUT /api/storage/objects/notes/hello.txt': jsonResponse({
        key: 'notes/hello.txt',
        size: 5,
      }),
    })
    const client = await connect()

    const bad = await client.callTool({
      name: 'storage_write',
      arguments: { key: 'notes/', content: 'x' },
    })
    expect((bad as ToolText).isError).toBe(true)

    const ok = await client.callTool({
      name: 'storage_write',
      arguments: { key: 'notes/hello.txt', content: 'hello' },
    })
    expect((ok as ToolText).isError).toBeFalsy()
    expect(calls.some((c) => c.method === 'PUT')).toBe(true)
  })
})
