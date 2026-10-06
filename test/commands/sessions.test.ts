import { describe, expect, it } from 'vitest'

import { registerSessions } from '../../src/commands/sessions.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { AGENT_ID, SESSION_ID, orgKeyRoutes, publishedKeyRoutes, session } from '../helpers/session-events.js'

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

  it('shows one session with its usage from /api/usage only', async () => {
    const calls = stubFetch({
      ...orgKeyRoutes(),
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(
        // The /v1 usage field is never shown (decision 0017).
        session('failed', { error: 'Out of credit', usage: { input_tokens: 12, output_tokens: 3 } }),
      ),
      [`GET /api/usage?start=0&session=${SESSION_ID}&group_by=model`]: jsonResponse({
        object: 'usage.summary',
        start: 0,
        end: 1_783_245_600,
        session_id: SESSION_ID,
        cost_micro_usd: 1_047,
        meters: [
          { meter: 'model_tokens', unit: 'tokens', quantity: 1_500, cost_micro_usd: 1_047, buckets: {} },
          { meter: 'web_searches', unit: 'searches', quantity: 0, cost_micro_usd: 0, buckets: {} },
        ],
        daily: [],
        groups: [{ meter: 'model_tokens', key: 'openai/gpt-5.5', quantity: 1_500, cost_micro_usd: 1_047 }],
      }),
    })
    await run(['sessions', 'get', SESSION_ID])
    expect(stdout()).toContain('status\tfailed')
    expect(stdout()).toContain('cost\t$0.001047')
    expect(stdout()).toContain('model_tokens\t1500')
    expect(stdout()).toContain('model_tokens:openai/gpt-5.5\t1500')
    expect(stdout()).toContain('web_searches\t0')
    expect(stdout()).toContain('compute_seconds\t0')
    expect(stdout()).not.toContain('12 in')
    expect(stdout()).toContain('error\tOut of credit')
    expect(calls.filter((c) => c.path.startsWith('/api/usage'))).toHaveLength(1)
  })

  it('prints the session with its /api/usage summary as usage with --json', async () => {
    const summary = { object: 'usage.summary', start: 0, end: 1, session_id: SESSION_ID, cost_micro_usd: 0, meters: [], daily: [], groups: [] }
    stubFetch({
      ...orgKeyRoutes(),
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(session('completed', { usage: { input_tokens: 12, output_tokens: 3 } })),
      [`GET /api/usage?start=0&session=${SESSION_ID}&group_by=model`]: jsonResponse(summary),
    })
    await run(['--json', 'sessions', 'get', SESSION_ID])
    expect(JSON.parse(stdout())).toMatchObject({ id: SESSION_ID, usage: summary })
  })

  it('shows a session to a published agent\'s key without usage, which it cannot read', async () => {
    const calls = stubFetch({
      ...publishedKeyRoutes(),
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(session('completed')),
    })
    await run(['sessions', 'get', SESSION_ID])
    expect(stdout()).toContain('status\tcompleted')
    expect(stdout()).not.toContain('cost\t')
    expect(calls.some((c) => c.path.startsWith('/api/usage'))).toBe(false)
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
