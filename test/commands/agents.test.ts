import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { registerAgents } from '../../src/commands/agents.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const ID = 'agent_' + '1'.repeat(32)
const OTHER = 'agent_' + '2'.repeat(32)

function agent(id: string, name: string | null) {
  return {
    id,
    object: 'agent',
    name,
    model: 'openai/gpt-5',
    instructions: 'Answer support questions.',
    metadata: {},
    tools: [],
    multi_agent: { enabled: false },
    created_at: 1_783_245_600,
    updated_at: 1_783_245_600,
  }
}

const { run, stdout, stderr } = commandHarness(registerAgents)

async function agentFile(body: string): Promise<string> {
  const file = path.join(os.tmpdir(), `orca-agent-${process.pid}-${Math.random()}.yaml`)
  await writeFile(file, body)
  return file
}

describe('agents list', () => {
  it('prints one row per agent and names the next cursor', async () => {
    stubFetch({ 'GET /v1/agents?limit=10': jsonResponse(list([agent(ID, 'support')], true)) })
    await run(['agents', 'list'])
    expect(stdout()).toBe(`${ID}\tsupport\topenai/gpt-5\t2026-07-05 10:00\n`)
    expect(stderr()).toContain(`--after ${ID}`)
  })

  it('passes --limit and --after through', async () => {
    const calls = stubFetch({ [`GET /v1/agents?limit=5&after=${OTHER}`]: jsonResponse(list([])) })
    await run(['agents', 'list', '--limit', '5', '--after', OTHER])
    expect(calls).toHaveLength(1)
    expect(stderr()).toContain('No agents yet')
  })
})

describe('agents get', () => {
  it('resolves a name to its id', async () => {
    const calls = stubFetch({
      'GET /v1/agents/support': jsonResponse({ error: { message: 'Agent not found' } }, { status: 404 }),
      'GET /v1/agents?limit=100': jsonResponse(list([agent(OTHER, 'other'), agent(ID, 'support')])),
    })
    await run(['agents', 'get', 'support'])
    // Not an id, so the server is asked for the name; the match is shown as listed.
    expect(calls.map((c) => c.path)).toEqual(['/v1/agents/support', '/v1/agents?limit=100'])
    expect(stdout()).toContain(`id\t${ID}`)
  })

  it('looks an id up once and shows it', async () => {
    const calls = stubFetch({ [`GET /v1/agents/${ID}`]: jsonResponse(agent(ID, 'support')) })
    await run(['--json', 'agents', 'get', ID])
    expect(calls).toHaveLength(1)
    expect(JSON.parse(stdout()).id).toBe(ID)
  })

  it('refuses a name two agents share', async () => {
    stubFetch({
      'GET /v1/agents/twin': jsonResponse({ error: { message: 'Agent not found' } }, { status: 404 }),
      'GET /v1/agents?limit=100': jsonResponse(list([agent(ID, 'twin'), agent(OTHER, 'twin')])),
    })
    await expect(run(['agents', 'get', 'twin'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('reports an unknown name as not found', async () => {
    stubFetch({
      'GET /v1/agents/ghost': jsonResponse({ error: { message: 'Agent not found' } }, { status: 404 }),
      'GET /v1/agents?limit=100': jsonResponse(list([])),
    })
    await expect(run(['agents', 'get', 'ghost'])).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })
})

describe('agents create and update', () => {
  it('posts the file as the agent body', async () => {
    const file = await agentFile('model: openai/gpt-5\nname: support\ninstructions: Be brief.\n')
    const calls = stubFetch({ 'POST /v1/agents': jsonResponse(agent(ID, 'support')) })
    await run(['agents', 'create', '-f', file])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
      model: 'openai/gpt-5',
      name: 'support',
      instructions: 'Be brief.',
    })
    expect(stdout()).toContain(`Created agent "support" (${ID})`)
  })

  it('needs a model before any request', async () => {
    const file = await agentFile('name: support\n')
    const calls = stubFetch({})
    await expect(run(['agents', 'create', '-f', file])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('updates only the fields in the file', async () => {
    const file = await agentFile('instructions: Be thorough.\n')
    const calls = stubFetch({
      [`GET /v1/agents/${ID}`]: jsonResponse(agent(ID, 'support')),
      [`POST /v1/agents/${ID}`]: jsonResponse(agent(ID, 'support')),
    })
    await run(['agents', 'update', ID, '-f', file])
    expect(JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}')).toEqual({ instructions: 'Be thorough.' })
  })

  it('maps a server validation error to its message', async () => {
    const file = await agentFile('model: openai/gpt-5\ncolor: blue\n')
    stubFetch({
      'POST /v1/agents': jsonResponse(
        { error: { message: 'Unknown agent field: color', type: 'invalid_request_error', param: 'color', code: 'invalid_request' } },
        { status: 400 },
      ),
    })
    await expect(run(['agents', 'create', '-f', file])).rejects.toMatchObject({
      message: '400: Unknown agent field: color (color)',
    })
  })
})

describe('agents delete', () => {
  it('refuses without --yes when not interactive', async () => {
    stubFetch({ [`GET /v1/agents/${ID}`]: jsonResponse(agent(ID, 'support')) })
    await expect(run(['agents', 'delete', ID])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({
      [`GET /v1/agents/${ID}`]: jsonResponse(agent(ID, 'support')),
      [`DELETE /v1/agents/${ID}`]: jsonResponse({ id: ID, object: 'agent.deleted', deleted: true }),
    })
    await run(['agents', 'delete', ID, '--yes'])
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })
})
