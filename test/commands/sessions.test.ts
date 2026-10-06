import { describe, expect, it } from 'vitest'

import { registerSessions } from '../../src/commands/sessions.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { AGENT_ID, SESSION_ID, orgKeyRoutes, session } from '../helpers/session-events.js'

const { run, stdout, stderr } = commandHarness(registerSessions)

describe('sessions', () => {
  it('lists sessions in plain mode', async () => {
    stubFetch({ 'GET /v1/agents/sessions?limit=10': jsonResponse(list([session('in_progress')])) })
    await run(['sessions', 'list'])
    expect(stdout()).toBe(`${SESSION_ID}\t${AGENT_ID}\tin_progress\tnone\t2026-07-05 10:00\n`)
  })

  it('filters by agent', async () => {
    const calls = stubFetch({
      ...orgKeyRoutes(),
      [`GET /v1/agents/sessions?limit=10&agent_id=${AGENT_ID}`]: jsonResponse(list([])),
    })
    await run(['sessions', 'list', '--agent', AGENT_ID])
    expect(calls.filter((c) => c.path.startsWith('/v1/agents/sessions'))).toHaveLength(1)
    expect(stderr()).toContain('No sessions yet')
  })

  it('shows one session', async () => {
    stubFetch({
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(
        session('failed', { error: 'Out of credit', usage: { input_tokens: 12, output_tokens: 3 } }),
      ),
    })
    await run(['sessions', 'get', SESSION_ID])
    expect(stdout()).toContain('status\tfailed')
    expect(stdout()).toContain('tokens\t12 in, 3 out')
    expect(stdout()).toContain('error\tOut of credit')
  })

  it('creates a session and prints its id when piped', async () => {
    const calls = stubFetch({ ...orgKeyRoutes(), 'POST /v1/agents/sessions': jsonResponse(session()) })
    await run(['sessions', 'create', '--agent', AGENT_ID, '--sandbox'])
    expect(JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted' },
    })
    expect(stdout()).toBe(`${SESSION_ID}\n`)
  })

  it('prints conversation items oldest first', async () => {
    stubFetch({
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=20&order=desc`]: jsonResponse(
        list([
          { id: 'msg_2', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello\u001b[2J there' }] },
          { id: 'call_1', type: 'function_call', name: 'lookup', status: 'completed' },
          { id: null, type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ]),
      ),
    })
    await run(['sessions', 'items', SESSION_ID])
    // Remote text never carries escape sequences to the terminal.
    expect(stdout()).toBe('user\thi\ntool\ttool lookup\nassistant\tHello there\n')
  })

  it('deletes with --yes and refuses without it', async () => {
    const calls = stubFetch({
      [`DELETE /v1/agents/sessions/${SESSION_ID}`]: jsonResponse({ id: SESSION_ID, deleted: true }),
    })
    await expect(run(['sessions', 'delete', SESSION_ID])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    await run(['sessions', 'delete', SESSION_ID, '--yes'])
    expect(calls).toHaveLength(1)
  })
})
