import { mkdir, mkdtemp, readdir, readFile, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { registerSessions } from '../../src/commands/sessions.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
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
  templateRoute,
  uploadedFile,
} from '../helpers/session-events.js'

const { run, stdout, stderr } = commandHarness(registerSessions)

describe('sessions', () => {
  it('lists sessions in plain mode', async () => {
    stubFetch({ 'GET /v1/agents/sessions?limit=10': jsonResponse(list([session('in_progress')])) })
    await run(['sessions', 'list'])
    expect(stdout()).toBe(`${SESSION_ID}\t${AGENT_ID}\tin_progress\tnone\t2026-07-05 10:00\n`)
  })

  it('filters by agent', async () => {
    const calls = stubFetch({
      ...agentRoute(),
      [`GET /v1/agents/sessions?limit=10&agent_id=${AGENT_ID}`]: jsonResponse(list([])),
    })
    await run(['sessions', 'list', '--agent', AGENT_ID])
    expect(calls.filter((c) => c.path.startsWith('/v1/agents/sessions'))).toHaveLength(1)
    expect(stderr()).toContain('No sessions yet')
  })

  it('shows one session with its usage from /api/usage only', async () => {
    const calls = stubFetch({
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
      // Switched to the organization's own OpenRouter key.
      ...sessionModelRoute('openrouter/openai/gpt-5.6-luna'),
    })
    await run(['sessions', 'get', SESSION_ID])
    expect(stdout()).toContain('model\topenrouter/openai/gpt-5.6-luna')
    expect(stdout()).toContain('agent_model\torca/openrouter/openai/gpt-5.6-luna')
    expect(stdout()).toContain('payer\town_key')
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
      [`GET /v1/agents/sessions/${SESSION_ID}`]: jsonResponse(session('completed', { usage: { input_tokens: 12, output_tokens: 3 } })),
      [`GET /api/usage?start=0&session=${SESSION_ID}&group_by=model`]: jsonResponse(summary),
      ...sessionModelRoute(),
    })
    await run(['--json', 'sessions', 'get', SESSION_ID])
    expect(JSON.parse(stdout())).toMatchObject({
      id: SESSION_ID,
      usage: summary,
      model: 'orca/openrouter/openai/gpt-5.6-luna',
      payer: 'orca_credit',
    })
  })

  it('creates a session and prints its id when piped', async () => {
    const calls = stubFetch({ ...agentRoute(), 'POST /v1/agents/sessions': jsonResponse(session()) })
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

  it('shows a web search with its query, and failed with the reason when it failed', async () => {
    const reason = 'openai/gpt-x answered without searching the web. Use a model with built-in web search: docs.orcapods.ai/providers#web-search'
    const search = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      id,
      type: 'web_search_call',
      status,
      turn_id: 'turn_1',
      action: { type: 'search', query: 'orca pods', queries: null },
      ...extra,
    })
    stubFetch({
      [`GET /v1/agents/sessions/${SESSION_ID}/items?limit=20&order=desc`]: jsonResponse(
        list([
          // An older server's failed search: no action, no error.
          search('ws_4', 'failed', { action: null }),
          // Stopped by the turn's cancellation: not a failure.
          search('ws_3', 'incomplete'),
          search('ws_2', 'incomplete', { error: { code: 'no_search', message: reason } }),
          search('ws_1', 'in_progress'),
        ]),
      ),
    })
    await run(['sessions', 'items', SESSION_ID])
    expect(stdout()).toBe(
      [
        'tool\ttool web_search "orca pods"',
        `tool\ttool web_search "orca pods" failed: ${reason}`,
        'tool\ttool web_search "orca pods"',
        'tool\ttool web_search failed',
        '',
      ].join('\n'),
    )
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

const ARTIFACTS = `/v1/agents/sessions/${SESSION_ID}/artifacts`
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'orca-artifacts-'))

describe('sessions artifacts', () => {
  it('lists artifacts in plain mode', async () => {
    stubFetch({
      [`GET ${ARTIFACTS}?limit=10`]: jsonResponse(list([artifact('art_2', '/workspace/outputs/primes.txt', 'turn_2')])),
    })
    await run(['sessions', 'artifacts', SESSION_ID])
    expect(stdout()).toBe('art_2\t/workspace/outputs/primes.txt\t5\tturn_2\t2026-07-05 10:00\n')
  })

  it('says how artifacts are kept when there are none', async () => {
    stubFetch({ [`GET ${ARTIFACTS}?limit=10`]: jsonResponse(list([])) })
    await run(['sessions', 'artifacts', SESSION_ID])
    expect(stdout()).toBe('')
    expect(stderr()).toContain('/workspace/outputs')
  })

  it('downloads one artifact\'s bytes to --output', async () => {
    const dest = path.join(await tmp(), 'out.txt')
    stubFetch({
      [`GET ${ARTIFACTS}/art_2`]: jsonResponse(artifact('art_2', '/workspace/outputs/primes.txt', 'turn_2')),
      [`GET ${ARTIFACTS}/art_2/content`]: bytesRoute([50, 10, 51, 10, 53]),
    })
    await run(['sessions', 'artifacts', 'download', SESSION_ID, 'art_2', '-o', dest])
    expect(await readFile(dest)).toEqual(Buffer.from('2\n3\n5'))
  })

  it('finds an artifact by its path, the newest at that path', async () => {
    const dir = await tmp()
    const calls = stubFetch({
      [`GET ${ARTIFACTS}?limit=100&order=desc`]: jsonResponse(
        list([artifact('art_2', '/workspace/outputs/primes.txt', 'turn_2'), artifact('art_1', '/workspace/outputs/primes.txt', 'turn_1')]),
      ),
      [`GET ${ARTIFACTS}/art_2/content`]: bytesRoute([1, 2, 3, 4, 5]),
    })
    await run(['sessions', 'artifacts', 'download', SESSION_ID, '/workspace/outputs/primes.txt', '-o', dir])
    expect(await readFile(path.join(dir, 'primes.txt'))).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(calls.some((c) => c.path.includes('art_1'))).toBe(false)
  })

  it('keeps a path with .. inside the target folder', async () => {
    const dir = await tmp()
    const target = path.join(dir, 'into')
    stubFetch({
      [`GET ${ARTIFACTS}/art_9`]: jsonResponse(artifact('art_9', '/workspace/outputs/../../escape.txt', 'turn_2')),
      [`GET ${ARTIFACTS}/art_9/content`]: bytesRoute([1, 2, 3, 4, 5]),
    })
    await mkdir(target)
    await run(['sessions', 'artifacts', 'download', SESSION_ID, 'art_9', '-o', target])
    expect(await readdir(target)).toEqual(['escape.txt'])
    expect(await readdir(dir)).toEqual(['into'])
  })

  it('refuses an artifact whose path has no file name', async () => {
    const dir = await tmp()
    const calls = stubFetch({
      [`GET ${ARTIFACTS}/art_9`]: jsonResponse(artifact('art_9', '/workspace/outputs/..', 'turn_2')),
    })
    await expect(run(['sessions', 'artifacts', 'download', SESSION_ID, 'art_9', '-o', dir])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
    })
    expect(calls.some((c) => c.path.endsWith('/content'))).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('downloads only the newest turn\'s artifacts with --all', async () => {
    const dir = path.join(await tmp(), 'results')
    const calls = stubFetch({
      [`GET ${ARTIFACTS}?limit=100&order=desc`]: jsonResponse(
        list([
          artifact('art_3', '/workspace/outputs/a.txt', 'turn_2', 1_783_245_700),
          artifact('art_2', '/workspace/outputs/sub/b.txt', 'turn_2', 1_783_245_700),
          artifact('art_1', '/workspace/outputs/old.txt', 'turn_1'),
        ]),
      ),
      [`GET ${ARTIFACTS}/art_3/content`]: bytesRoute([97]),
      [`GET ${ARTIFACTS}/art_2/content`]: bytesRoute([98]),
    })
    await run(['--json', 'sessions', 'artifacts', 'download', SESSION_ID, '--all', '-o', dir])
    expect((await readdir(dir)).sort()).toEqual(['a.txt', 'b.txt'])
    expect(calls.some((c) => c.path.includes('art_1'))).toBe(false)
    const saved = JSON.parse(stdout()) as { id: string; bytes: number }[]
    expect(saved.map((s) => [s.id, s.bytes])).toEqual([
      ['art_3', 1],
      ['art_2', 1],
    ])
  })

  it('refuses two artifacts with one name before writing anything', async () => {
    const dir = await tmp()
    const calls = stubFetch({
      [`GET ${ARTIFACTS}?limit=100&order=desc`]: jsonResponse(
        list([artifact('art_3', '/workspace/outputs/a.txt', 'turn_2'), artifact('art_2', '/workspace/outputs/sub/a.txt', 'turn_2')]),
      ),
    })
    await expect(run(['sessions', 'artifacts', 'download', SESSION_ID, '--all', '-o', dir])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      detail: expect.arrayContaining(['/workspace/outputs/a.txt', '/workspace/outputs/sub/a.txt']),
    })
    expect(calls.some((c) => c.path.endsWith('/content'))).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('needs an artifact or --all, and --all cannot go to stdout', async () => {
    const calls = stubFetch({})
    await expect(run(['sessions', 'artifacts', 'download', SESSION_ID])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    await expect(run(['sessions', 'artifacts', 'download', SESSION_ID, 'art_1', '--all'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    await expect(run(['sessions', 'artifacts', 'download', SESSION_ID, '--all', '-o', '-'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('fails when the session has no artifacts', async () => {
    stubFetch({ [`GET ${ARTIFACTS}?limit=100&order=desc`]: jsonResponse(list([])) })
    await expect(run(['sessions', 'artifacts', 'download', SESSION_ID, '--all', '-o', await tmp()])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
    })
  })
})

describe('sessions create --file', () => {
  const local = async (name = 'data.csv', bytes = 'a,b\n1,2\n') => {
    const file = path.join(await tmp(), name)
    await writeFile(file, bytes)
    return file
  }

  it('uploads each file, then creates a sandbox with them by file_id', async () => {
    const data = await local()
    const notes = await local('notes.md')
    const calls = stubFetch({
      ...agentRoute(),
      'POST /v1/files': (call) =>
        jsonResponse(uploadedFile(calls.filter((c) => c.path === '/v1/files').length === 1 ? 'file_1' : 'file_2', 'x'))(call),
      'POST /v1/agents/sessions': jsonResponse(hostedSession()),
    })
    await run(['sessions', 'create', '--agent', AGENT_ID, '--file', data, '--file', `${notes}:docs/notes.md`])
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(order).toEqual(['/v1/files', '/v1/files', '/v1/agents/sessions'])
    expect((calls[1].form?.get('file') as File).name).toBe('data.csv')
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: {
        type: 'openai_hosted',
        files: [
          { type: 'file_id', file_id: 'file_1', path: '/workspace/data.csv' },
          { type: 'file_id', file_id: 'file_2', path: '/workspace/docs/notes.md' },
        ],
      },
    })
    expect(stdout()).toBe(`${SESSION_ID}\n`)
  })

  it('keeps a template\'s own files: stages through the environment after the create', async () => {
    const data = await local()
    const calls = stubFetch({
      ...agentRoute(),
      ...templateRoute('tmpl_1'),
      'POST /v1/files': jsonResponse(uploadedFile('file_1', 'data.csv')),
      'POST /v1/agents/sessions': jsonResponse(hostedSession()),
      'POST /v1/agents/environments/env_1/files': jsonResponse({
        environment_id: 'env_1',
        object: 'agent.environment.file',
        path: '/workspace/data.csv',
        size_bytes: 8,
      }),
    })
    await run(['sessions', 'create', '--agent', AGENT_ID, '--template', 'tmpl_1', '--file', data])
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/sessions')?.body ?? '{}')).toEqual({
      agent_id: AGENT_ID,
      environment: { type: 'openai_hosted', environment_template_id: 'tmpl_1' },
    })
    expect(JSON.parse(calls.find((c) => c.path === '/v1/agents/environments/env_1/files')?.body ?? '{}')).toEqual({
      type: 'file_id',
      file_id: 'file_1',
      path: '/workspace/data.csv',
    })
  })

  it('refuses a file over the staging limit before uploading, naming the limit', async () => {
    const big = await local('big.bin', '')
    await truncate(big, 16 * 1024 * 1024 + 1)
    const calls = stubFetch({})
    await expect(run(['sessions', 'create', '--agent', AGENT_ID, '--file', big])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
      message: expect.stringContaining('16 MiB'),
    })
    expect(calls).toHaveLength(0)
  })

  it('refuses a path that is not a file before any request', async () => {
    const calls = stubFetch({})
    await expect(run(['sessions', 'create', '--agent', AGENT_ID, '--file', os.tmpdir()])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('deletes the files it uploaded when the create fails', async () => {
    const data = await local()
    const calls = stubFetch({
      ...agentRoute(),
      'POST /v1/files': jsonResponse(uploadedFile('file_1', 'data.csv')),
      'POST /v1/agents/sessions': jsonResponse({ error: { message: 'bad', code: 'invalid_value' } }, { status: 400 }),
      'DELETE /v1/files/file_1': jsonResponse({ id: 'file_1', object: 'file', deleted: true }),
    })
    await expect(run(['sessions', 'create', '--agent', AGENT_ID, '--file', data])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
    })
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/files/file_1')).toBe(true)
  })
})
