import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { registerAgents } from '../../src/commands/agents.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

// The model picker, so a test can see what it offers and answer for the
// person at the terminal.
const pickItem = vi.hoisted(() => vi.fn())
vi.mock('../../src/ui/AgentPicker.js', () => ({ pickItem, pickOne: vi.fn() }))

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
    const file = await agentFile('model: orca/openrouter/openai/gpt-5.6-luna\nname: support\ninstructions: Be brief.\n')
    const calls = stubFetch({ 'POST /v1/agents': jsonResponse(agent(ID, 'support')) })
    await run(['agents', 'create', '-f', file])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
      model: 'orca/openrouter/openai/gpt-5.6-luna',
      name: 'support',
      instructions: 'Be brief.',
    })
    expect(stdout()).toContain(`Created agent "support" (${ID})`)
  })

  it('needs a model in the file outside a terminal, before any request', async () => {
    const file = await agentFile('name: support\n')
    const calls = stubFetch({})
    // The test runner is not a terminal, so no picker opens; --json never opens one either.
    for (const argv of [['agents', 'create', '-f', file], ['--json', 'agents', 'create', '-f', file]]) {
      await expect(run(argv)).rejects.toMatchObject({ exitCode: ExitCode.Usage, message: `${file} needs a model` })
    }
    expect(calls).toHaveLength(0)
  })

  it("prints the server's refusal of a model on the model field", async () => {
    const file = await agentFile('model: openai/gpt-5.6-luna\n')
    const message = 'Add your OpenAI key in Settings, Providers, or use orca/openrouter/openai/gpt-5.6-luna for Orca credit'
    stubFetch({
      'POST /v1/agents': jsonResponse(
        { error: { message, type: 'invalid_request_error', param: 'model', code: 'invalid_request' } },
        { status: 400 },
      ),
    })
    await expect(run(['agents', 'create', '-f', file])).rejects.toMatchObject({ message: `400: ${message} (model)` })
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
    const file = await agentFile('model: orca/openrouter/openai/gpt-5.6-luna\ncolor: blue\n')
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

describe('agents create with no model, at a terminal', () => {
  const FREE = 'orca/openrouter/cohere/north-mini-code:free'
  const LUNA = 'orca/openrouter/openai/gpt-5.6-luna'
  const models = (free: boolean) => ({
    object: 'list',
    openrouter_fee_bps: 550,
    groups: [
      {
        payer: 'orca_credit',
        provider: 'openrouter',
        label: 'Orca credit',
        available: true,
        models: [
          { id: LUNA, input_micro_usd_per_million: 400_000, output_micro_usd_per_million: 1_800_000, plan: 'within_ceiling' },
          ...(free ? [{ id: FREE, input_micro_usd_per_million: 0, output_micro_usd_per_million: 0, plan: 'free' }] : []),
        ],
      },
      { payer: 'own_key', provider: 'anthropic', label: 'Anthropic', available: true, models: [{ id: 'anthropic/claude-sonnet-4-5' }] },
    ],
  })

  async function asTerminal(fn: () => Promise<void>): Promise<void> {
    const [stdin, stdoutTty] = [process.stdin.isTTY, process.stdout.isTTY]
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    try {
      await fn()
    } finally {
      process.stdin.isTTY = stdin
      process.stdout.isTTY = stdoutTty
    }
  }

  it('offers the free model first, preselected, on Free (free-plan D3.16)', async () => {
    const file = await agentFile('name: support\n')
    pickItem.mockResolvedValueOnce(FREE)
    const calls = stubFetch({
      'GET /api/models': jsonResponse(models(true)),
      'GET /api/billing/wallet': jsonResponse({ tier: 'free' }),
      'POST /v1/agents': jsonResponse(agent(ID, 'support')),
    })
    await asTerminal(() => run(['agents', 'create', '-f', file]))
    const [, items, initial] = pickItem.mock.calls.at(-1) as [string, { value: string; detail: string }[], string | undefined]
    expect(items.map((item) => item.value)).toEqual([FREE, LUNA, 'anthropic/claude-sonnet-4-5'])
    expect(items[0].detail).toMatch(/free model$/)
    expect(initial).toBe(FREE)
    expect(JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}')).toEqual({ name: 'support', model: FREE })
  })

  it('keeps the server\'s order and preselects nothing on Pro and Max, the free model marked (amendment A4)', async () => {
    for (const tier of ['pro', 'max']) {
      const file = await agentFile('name: support\n')
      pickItem.mockResolvedValueOnce(LUNA)
      stubFetch({
        'GET /api/models': jsonResponse(models(true)),
        'GET /api/billing/wallet': jsonResponse({ tier }),
        'POST /v1/agents': jsonResponse(agent(ID, 'support')),
      })
      await asTerminal(() => run(['agents', 'create', '-f', file]))
      const [, items, initial] = pickItem.mock.calls.at(-1) as [string, { value: string; detail: string }[], string | undefined]
      expect(items.map((item) => item.value)).toEqual([LUNA, FREE, 'anthropic/claude-sonnet-4-5'])
      expect(items[1].detail).toMatch(/free model$/)
      expect(initial).toBeUndefined()
    }
  })

  it('preselects nothing while the free models are off (amendment A5)', async () => {
    const file = await agentFile('name: support\n')
    pickItem.mockResolvedValueOnce(LUNA)
    stubFetch({
      'GET /api/models': jsonResponse(models(false)),
      'GET /api/billing/wallet': jsonResponse({ tier: 'free' }),
      'POST /v1/agents': jsonResponse(agent(ID, 'support')),
    })
    await asTerminal(() => run(['agents', 'create', '-f', file]))
    const [, items, initial] = pickItem.mock.calls.at(-1) as [string, { value: string }[], string | undefined]
    expect(items.map((item) => item.value)).toEqual([LUNA, 'anthropic/claude-sonnet-4-5'])
    expect(initial).toBeUndefined()
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
