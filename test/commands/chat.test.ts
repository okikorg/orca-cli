import { mkdtemp, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { registerChat, switcher } from '../../src/commands/chat.js'
import { ApiClient } from '../../src/lib/api.js'
import { ExitCode } from '../../src/lib/errors.js'
import { API, commandHarness, KEY, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import {
  AGENT_ID,
  SESSION_ID,
  agentRoute,
  TEMPLATE_ID,
  VAULT_ID,
  hostedSession,
  session,
  sessionModelRoute,
  template,
  templateByName,
  templateRoute,
  turnEvents,
  turnRoutes,
  uploadedFile,
  vault,
  vaultByName,
  vaultRoute,
} from '../helpers/session-events.js'

const { run, stdout, stderr } = commandHarness(registerChat)

describe('orca chat (single shot)', () => {
  it('creates a session of the agent, streams the reply, and names the session on stderr', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', AGENT_ID, 'hi', 'there'])

    const created = JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')
    expect(created).toEqual({ agent_id: AGENT_ID, environment: { type: 'none' } })
    const input = JSON.parse(calls.find((c) => c.method === 'POST' && c.path.endsWith('/events'))?.body ?? '{}')
    expect(input.events[0]).toEqual({
      type: 'agent.session.input.message',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi there' }] }],
    })
    // Two message items read as two paragraphs.
    expect(stdout()).toBe('Let me look.\n\nHello there\n')
    expect(stderr()).toContain(`session ${SESSION_ID}`)
  })

  it('continues a session with --session, creating nothing', async () => {
    const calls = stubFetch(turnRoutes(turnEvents()))
    await run(['chat', 'support', '--session', SESSION_ID, 'again'])
    expect(calls.some((c) => c.path === '/v1/agents/sessions')).toBe(false)
    expect(stdout()).toContain('Hello there')
  })

  it('asks for a hosted sandbox from a template and attaches vaults', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      ...templateRoute('tmpl_1'),
      ...vaultRoute('vault_1'),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', AGENT_ID, '--template', 'tmpl_1', '--vault', 'vault_1', 'go'])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted', environment_template_id: 'tmpl_1' },
      vault_ids: ['vault_1'],
    })
  })

  it('takes a template and a vault by name', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      ...templateByName('seo-helper', [template('envtmpl_other', 'other'), template()]),
      ...vaultByName('dataforseo', [vault()]),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', AGENT_ID, '--template', 'seo-helper', '--vault', 'dataforseo', 'go'])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted', environment_template_id: TEMPLATE_ID },
      vault_ids: [VAULT_ID],
    })
  })

  it('reads the prompt from stdin', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    // The test runner's stdin is not a TTY, so the command reads it.
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      () => Readable.from([Buffer.from('from stdin\n')])[Symbol.asyncIterator]() as never,
    )
    await run(['chat', AGENT_ID])
    const input = JSON.parse(calls.find((c) => c.method === 'POST' && c.path.endsWith('/events'))?.body ?? '{}')
    expect(input.events[0].input[0].content[0].text).toBe('from stdin')
  })

  it('fails with the turn error after printing what arrived', async () => {
    stubFetch({ ...agentRoute(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(turnEvents('failed')) })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: 'Out of credit',
    })
  })

  it('emits each raw session event as NDJSON with --json', async () => {
    stubFetch({ ...agentRoute(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(turnEvents()) })
    await run(['--json', 'chat', AGENT_ID, 'hi'])
    const lines = stdout().trim().split('\n').map((l) => JSON.parse(l) as { type: string })
    expect(lines[0].type).toBe('agent.session.turn.created')
    expect(lines.at(-1)?.type).toBe('agent.session.idle')
  })

  it('maps an out-of-credit refusal before the stream opens', async () => {
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: jsonResponse(
        { error: { message: 'Out of credit', code: 'insufficient_quota' } },
        { status: 429 },
      ),
    })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({ message: '429: Out of credit' })
  })

  it('resolves an agent name', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      'GET /v1/agents/support': jsonResponse({ error: { message: 'Agent not found' } }, { status: 404 }),
      'GET /v1/agents?limit=100': jsonResponse(list([{ id: AGENT_ID, name: 'support' }])),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', 'support', 'hi'])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}').agent_id).toBe(AGENT_ID)
  })

  it('requires an agent when not interactive', async () => {
    stubFetch({})
    await expect(run(['chat'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('orca chat keeps its session id', () => {
  it('names the session even when the turn is refused after it was made', async () => {
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: jsonResponse({ error: { message: 'Out of credit', code: 'insufficient_quota' } }, { status: 429 }),
    })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({ message: '429: Out of credit' })
    expect(stderr()).toContain(`session ${SESSION_ID}`)
  })
})

describe('agent references', () => {
  it('reads an id as an id by asking the server, not by its shape', async () => {
    // A name shaped like an id: only the server can tell.
    const lookalike = 'agent_' + 'f'.repeat(32)
    const calls = stubFetch({
      [`GET /v1/agents/${lookalike}`]: jsonResponse({ error: { message: 'Agent not found' } }, { status: 404 }),
      'GET /v1/agents?limit=100': jsonResponse(list([{ id: AGENT_ID, name: lookalike }])),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', lookalike, 'hi'])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}').agent_id).toBe(AGENT_ID)
  })
})

describe('orca chat --file', () => {
  const local = async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'orca-chat-')), 'sales.csv')
    await writeFile(file, 'month,total\n')
    return file
  }

  it('uploads the file, then creates a sandbox with it by file_id, then sends the message', async () => {
    const data = await local()
    const calls = stubFetch({
      ...agentRoute(),
      'POST /v1/files': jsonResponse(uploadedFile('file_1', 'sales.csv')),
      'POST /v1/agents/sessions': jsonResponse(hostedSession()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', AGENT_ID, '--file', `${data}:/workspace/in/sales.csv`, 'analyse /workspace/in/sales.csv'])
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(posts).toEqual(['/v1/files', '/v1/agents/sessions', `/v1/agents/sessions/${SESSION_ID}/events`])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted', files: [{ type: 'file_id', file_id: 'file_1', path: '/workspace/in/sales.csv' }] },
    })
    expect(stdout()).toContain('Hello there')
  })

  it('stages into the sandbox of the session --session continues', async () => {
    const data = await local()
    const calls = stubFetch({
      ...turnRoutes(turnEvents()),
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(hostedSession()),
      'POST /v1/files': jsonResponse(uploadedFile('file_1', 'sales.csv')),
      'POST /v1/agents/environments/env_1/files': jsonResponse({
        environment_id: 'env_1',
        object: 'agent.environment.file',
        path: '/workspace/sales.csv',
        size_bytes: 12,
      }),
    })
    await run(['chat', 'support', '--session', SESSION_ID, '--file', data, 'again'])
    expect(calls.some((c) => c.path === '/v1/agents/sessions')).toBe(false)
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/environments/env_1/files')?.body ?? '{}')).toEqual({
      type: 'file_id',
      file_id: 'file_1',
      path: '/workspace/sales.csv',
    })
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(posts.indexOf('/v1/agents/environments/env_1/files')).toBeLessThan(posts.indexOf(`/v1/agents/sessions/${SESSION_ID}/events`))
  })

  it('refuses --file for a session with no sandbox, uploading nothing', async () => {
    const data = await local()
    const calls = stubFetch({ [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(session()) })
    await expect(run(['chat', 'support', '--session', SESSION_ID, '--file', data, 'again'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses a file over the staging limit before anything is sent', async () => {
    const data = await local()
    await truncate(data, 17 * 1024 * 1024)
    const calls = stubFetch({})
    await expect(run(['chat', AGENT_ID, '--file', data, 'go'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
      message: expect.stringContaining('16 MiB'),
    })
    expect(calls).toHaveLength(0)
  })
})

// One turn on SESSION_ID with the server's Free plan notices in it
// (free-plan D3.16): they are session events, not the turn's.
function turnWithNotices(): Record<string, unknown>[] {
  const events = turnEvents()
  const notices = [
    { event_id: 'evt_n1', session_id: SESSION_ID, type: 'orca.network.off', message: NETWORK, at: 1_783_245_600 },
    { event_id: 'evt_n2', session_id: SESSION_ID, type: 'orca.compute.warning', message: WARNING, at: 1_783_245_601 },
    { event_id: 'evt_n3', session_id: SESSION_ID, type: 'orca.free_model.turn_limit', message: TURN_LIMIT, at: 1_783_245_602 },
    { event_id: 'evt_n4', session_id: SESSION_ID, type: 'orca.turn.time_limit', message: TIME_LIMIT, at: 1_783_245_603 },
  ]
  return [events[0], notices[0], notices[1], ...events.slice(1, -2), notices[2], notices[3], ...events.slice(-2)]
}

const NETWORK = "The network is off in Free sandboxes until you add credit. Agents can still run code, but can't install packages or reach the internet."
const WARNING = '5 minutes of included machine time left this month. Add credit to keep the sandbox running after that.'
const TURN_LIMIT = "This turn reached the free model's 25 calls. Send a message to continue."
const TIME_LIMIT = "This turn reached Free's 30 minutes. Send a message to continue."

describe('orca chat on the Free plan (free-plan D3.16)', () => {
  it('prints each session notice on stderr, the network line as every surface says it, and keeps stdout the reply', async () => {
    stubFetch({ ...agentRoute(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(turnWithNotices()) })
    await run(['chat', AGENT_ID, 'hi'])
    expect(stdout()).toBe('Let me look.\n\nHello there\n')
    expect(stderr()).toContain(`network  off. ${NETWORK}\n`)
    expect(stderr()).toContain(`${WARNING}\n`)
    expect(stderr()).toContain(`${TURN_LIMIT}\n`)
    expect(stderr()).toContain(`${TIME_LIMIT}\n`)
  })

  it('passes the notices through as raw events with --json', async () => {
    stubFetch({ ...agentRoute(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(turnWithNotices()) })
    await run(['--json', 'chat', AGENT_ID, 'hi'])
    const types = stdout().trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type)
    expect(types).toEqual(expect.arrayContaining(['orca.network.off', 'orca.compute.warning', 'orca.free_model.turn_limit', 'orca.turn.time_limit']))
    expect(stderr()).not.toContain(NETWORK)
  })

  it('prints a model the plan refuses as the server wrote it, with the ways forward, exit 1', async () => {
    const message = 'This model is not part of this plan.'
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: jsonResponse(
        { error: { message, type: 'invalid_request_error', param: 'agent.model', code: 'model_not_in_plan' } },
        { status: 403 },
      ),
    })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message,
      detail: [
        'Upgrade: orca billing buy pro, or orca billing buy max',
        'Switch this session to the free model (orca chat offers it at a terminal)',
      ],
    })
    expect(stderr()).toContain(`session ${SESSION_ID}`)
  })

  it('tells a free model on a plan with no share from any other model by the session\'s model (amendment A5)', async () => {
    const message = "Orca's free model is not part of this plan. Switch this session to another model, or run it on your own OpenRouter key."
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: jsonResponse(
        { error: { message, type: 'invalid_request_error', param: 'agent.model', code: 'model_not_in_plan' } },
        { status: 403 },
      ),
      [`GET /api/sessions/${SESSION_ID}/model`]: jsonResponse({
        object: 'session.model',
        session_id: SESSION_ID,
        model: 'orca/openrouter/cohere/north-mini-code:free',
        agent_model: 'orca/openrouter/cohere/north-mini-code:free',
        payer: 'orca_credit',
      }),
    })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message,
      detail: ['Add your own OpenRouter key: in the dashboard, Settings, Providers'],
    })
  })

  // GET /api/models with the free models the server lists now.
  const modelsListing = (free: string[]) =>
    jsonResponse({
      object: 'list',
      openrouter_fee_bps: 550,
      groups: [
        {
          payer: 'orca_credit',
          provider: 'openrouter',
          label: 'Orca credit',
          available: true,
          models: free.map((id) => ({ id, input_micro_usd_per_million: 0, output_micro_usd_per_million: 0, plan: 'free' })),
        },
      ],
    })

  it('prints the free model switched off (amendment A5) as the server wrote it, on any plan, with no switch to offer', async () => {
    const message = "Orca's free model is off right now. Switch this session to another model, add your own OpenRouter key, or add credit."
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: jsonResponse(
        { error: { message, type: 'invalid_request_error', param: 'agent.model', code: 'free_model_unavailable' } },
        { status: 503 },
      ),
      'GET /api/models': modelsListing([]),
    })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message,
      detail: [
        'Add your own OpenRouter key: in the dashboard, Settings, Providers',
        'Add credit: orca billing buy pack:<cents> (orca billing wallet lists the packs)',
      ],
    })
  })

  it('offers the switch to the next free model for one withdrawn while the server lists another (amendment A3 (3))', async () => {
    const message =
      "Orca's free model North Mini Code is not available right now. Switch this session to MiniMax M3.1 Flash, add your own OpenRouter key, or add credit to use another model."
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: jsonResponse(
        { error: { message, type: 'invalid_request_error', param: 'agent.model', code: 'free_model_unavailable' } },
        { status: 503 },
      ),
      'GET /api/models': modelsListing(['orca/openrouter/minimax/minimax-m3.1-flash:free']),
    })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message,
      detail: [
        'Switch this session to the free model (orca chat offers it at a terminal)',
        'Add your own OpenRouter key: in the dashboard, Settings, Providers',
        'Add credit: orca billing buy pack:<cents> (orca billing wallet lists the packs)',
      ],
    })
  })

  it('prints a paid model refused at $0 on Free with its four ways forward', async () => {
    const message = 'On Free, this agent\'s model runs on credit. Switch this session to the free model (cohere/north-mini-code:free), add your own provider key in Settings, Providers, or add credit or upgrade: https://app.orcapods.ai/wallet'
    stubFetch({
      ...agentRoute(),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
      [`POST /v1/agents/sessions/${SESSION_ID}/events`]: jsonResponse(
        { error: { message, type: 'insufficient_quota', param: 'free_plan', code: 'insufficient_quota' } },
        { status: 429 },
      ),
    })
    const err = await run(['chat', AGENT_ID, 'hi']).catch((e: unknown) => e)
    expect(err).toMatchObject({ exitCode: ExitCode.Failure, message })
    expect((err as { detail: string[] }).detail).toHaveLength(4)
  })

  it('ends a turn stopped at the included machine time with the server\'s message alone, which says whether credit continues it', async () => {
    const events = turnEvents('failed').map((e) =>
      e.type === 'agent.session.turn.failed'
        ? {
            ...e,
            turn: {
              ...(e.turn as Record<string, unknown>),
              error: { code: 'usage_limit_exceeded', param: 'included_hours', message: "Free's 1 included hour this month is used up and this organization has no credit. The workspace is saved. Add credit to continue now, or it resumes on 1 November." },
            },
          }
        : e,
    )
    stubFetch({ ...agentRoute(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(events) })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: expect.stringContaining('The workspace is saved.'),
      detail: undefined,
    })
  })

  it('keeps an out-of-credit turn as it was, with no Free plan words', async () => {
    stubFetch({ ...agentRoute(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(turnEvents('failed')) })
    const err = await run(['chat', AGENT_ID, 'hi']).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'Out of credit' })
    expect((err as { detail?: string[] }).detail).toBeUndefined()
  })
})

describe('the switch on Free', () => {
  const FREE = 'orca/openrouter/cohere/north-mini-code:free'
  const models = {
    object: 'list',
    openrouter_fee_bps: 550,
    groups: [
      {
        payer: 'orca_credit',
        provider: 'openrouter',
        label: 'Orca credit',
        available: true,
        models: [
          { id: 'orca/openrouter/anthropic/claude-fable-5', input_micro_usd_per_million: 10_000_000, output_micro_usd_per_million: 50_000_000, plan: 'within_ceiling' },
          { id: FREE, input_micro_usd_per_million: 0, output_micro_usd_per_million: 0, plan: 'free' },
        ],
      },
      { payer: 'own_key', provider: 'anthropic', label: 'Anthropic', available: true, models: [{ id: 'anthropic/claude-sonnet-4-5' }] },
    ],
  }
  const api = () => ({
    client: new ApiClient({ apiUrl: API, apiKey: KEY, contextName: 'default' }),
    resolved: { name: 'default', apiUrl: API, apiKey: KEY, defaulted: new Set<never>(), configPath: '' },
  })

  it('offers the free model first and preselected when the refusal offers it', async () => {
    stubFetch({ ...sessionModelRoute('orca/openrouter/anthropic/claude-fable-5', 'orca/openrouter/anthropic/claude-fable-5'), 'GET /api/models': jsonResponse(models) })
    const offer = await switcher(api()).load(SESSION_ID, true)
    expect(offer.items.map((item) => item.value)).toEqual([FREE, 'anthropic/claude-sonnet-4-5'])
    expect(offer.initial).toBe(FREE)
    expect(offer.freeModel).toBe(true)
  })

  it('offers only the other side otherwise, as before', async () => {
    stubFetch({ ...sessionModelRoute('orca/openrouter/anthropic/claude-fable-5', 'orca/openrouter/anthropic/claude-fable-5'), 'GET /api/models': jsonResponse(models) })
    const offer = await switcher(api()).load(SESSION_ID)
    expect(offer.items.map((item) => item.value)).toEqual(['anthropic/claude-sonnet-4-5'])
    expect(offer.initial).toBeUndefined()
    expect(offer.freeModel).toBeUndefined()
  })
})
