import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { registerChat } from '../../src/commands/chat.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { AGENT_ID, SESSION_ID, orgKeyRoutes, publishedKeyRoutes, session, turnEvents, turnRoutes } from '../helpers/session-events.js'

const { run, stdout, stderr } = commandHarness(registerChat)

describe('orca chat (single shot)', () => {
  it('creates a session of the agent, streams the reply, and names the session on stderr', async () => {
    const calls = stubFetch({
      ...orgKeyRoutes(),
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
      ...orgKeyRoutes(),
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

  it('reads the prompt from stdin', async () => {
    const calls = stubFetch({
      ...orgKeyRoutes(),
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
    stubFetch({ ...orgKeyRoutes(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(turnEvents('failed')) })
    await expect(run(['chat', AGENT_ID, 'hi'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: 'Out of credit',
    })
  })

  it('emits each raw session event as NDJSON with --json', async () => {
    stubFetch({ ...orgKeyRoutes(), 'POST /v1/agents/sessions': jsonResponse(session()), ...turnRoutes(turnEvents()) })
    await run(['--json', 'chat', AGENT_ID, 'hi'])
    const lines = stdout().trim().split('\n').map((l) => JSON.parse(l) as { type: string })
    expect(lines[0].type).toBe('agent.session.turn.created')
    expect(lines.at(-1)?.type).toBe('agent.session.idle')
  })

  it('maps an out-of-credit refusal before the stream opens', async () => {
    stubFetch({
      ...orgKeyRoutes(),
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
      ...orgKeyRoutes(),
      'GET /v1/agents/support': jsonResponse({ error: { message: 'Agent not found' } }, { status: 404 }),
      'GET /v1/agents?limit=100': jsonResponse(list([{ id: AGENT_ID, name: 'support' }])),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', 'support', 'hi'])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}').agent_id).toBe(AGENT_ID)
  })

  it('requires an agent when not interactive', async () => {
    stubFetch(orgKeyRoutes())
    await expect(run(['chat'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('orca chat with a published agent\'s key', () => {
  it('names the published environment and vaults, and needs no agent', async () => {
    const calls = stubFetch({
      ...publishedKeyRoutes({ type: 'openai_hosted', environment_template_id: 'envtmpl_1' }, ['vault_1']),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', AGENT_ID, 'hi'])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted', environment_template_id: 'envtmpl_1' },
      vault_ids: ['vault_1'],
    })
    // It reads no agent: a published key may not.
    expect(calls.some((c) => c.path.startsWith('/v1/agents/agent_'))).toBe(false)
  })

  it('refuses what its publisher chose, and another agent', async () => {
    stubFetch(publishedKeyRoutes())
    await expect(run(['chat', AGENT_ID, '--vault', 'vault_9', 'hi'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    await expect(run(['chat', 'agent_' + '2'.repeat(32), 'hi'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('orca chat keeps its session id', () => {
  it('names the session even when the turn is refused after it was made', async () => {
    stubFetch({
      ...orgKeyRoutes(),
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
      'GET /api/whoami': jsonResponse({ object: 'whoami', tenant: 'org_1', actor: 'key_1', role: 'admin', agent: null }),
      'POST /v1/agents/sessions': jsonResponse(session()),
      ...turnRoutes(turnEvents()),
    })
    await run(['chat', lookalike, 'hi'])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}').agent_id).toBe(AGENT_ID)
  })
})
