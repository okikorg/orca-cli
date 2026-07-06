import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerWorkflows } from '../../src/commands/workflows.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { chunkedBytes, sseFrames, streamResponse } from '../helpers/sse-stream.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerWorkflows(program)
  await program.parseAsync(args, { from: 'user' })
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  delete process.env.ORCA_API_KEY
  delete process.env.ORCA_API_URL
  await saveConfig({
    currentContext: 'default',
    contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } },
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .join('')
}

const NODES = [
  { id: 'fetch', title: 'Fetch', profile: 'collector', promptTemplate: 'p', dependsOn: [], status: 0, attempt: 0 },
  { id: 'draft', title: 'Draft', profile: 'writer', promptTemplate: 'p', dependsOn: ['fetch'], status: 0, attempt: 0 },
]

const DEF = {
  id: 'wfdef-1',
  name: 'Nightly report',
  description: 'builds a report',
  userPrompt: 'do it',
  nodes: NODES,
  createdAt: '2026-07-05T09:00:00Z',
  updatedAt: '2026-07-05T10:00:00Z',
}

const RUN = {
  id: 'workflow-1',
  userPrompt: 'do it',
  status: 3,
  autoStart: true,
  nodes: [
    { ...NODES[0], status: 3 },
    { ...NODES[1], status: 3 },
  ],
  createdAt: '2026-07-05T10:00:00Z',
  startedAt: '2026-07-05T10:00:01Z',
  finishedAt: '2026-07-05T10:00:31Z',
  repairCount: 0,
}

const SCHED = {
  id: 'wfsched-1',
  workflowDefinitionId: 'wfdef-1',
  name: 'nightly',
  cron: '0 2 * * *',
  timezone: 'UTC',
  status: 'active',
  createdAt: '2026-07-05T09:00:00Z',
  updatedAt: '2026-07-05T10:00:00Z',
}

describe('workflows list (definitions)', () => {
  it('emits raw JSON with --json and sends the default limit', async () => {
    const calls = stubFetch({ 'GET /api/workflows/definitions?limit=10': jsonResponse([DEF]) })
    await run(['--json', 'workflows', 'list'])
    expect(JSON.parse(stdout())).toEqual([DEF])
    expect(calls[0].path).toBe('/api/workflows/definitions?limit=10')
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({ 'GET /api/workflows/definitions?limit=10': jsonResponse([DEF]) })
    await run(['workflows', 'list'])
    expect(stdout()).toBe('Nightly report\twfdef-1\t2\t2026-07-05 10:00\n')
  })

  it('forwards --limit/--offset and hints on stderr when the server has more', async () => {
    const calls = stubFetch({
      'GET /api/workflows/definitions?limit=1&offset=2': jsonResponse([DEF], {
        headers: { 'X-Total-Count': '6' },
      }),
    })
    await run(['workflows', 'list', '--limit', '1', '--offset', '2'])
    expect(calls[0].path).toBe('/api/workflows/definitions?limit=1&offset=2')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 6')
  })

  it('maps 401 to the auth exit code', async () => {
    stubFetch({
      'GET /api/workflows/definitions?limit=10': jsonResponse({ error: 'nope' }, { status: 401 }),
    })
    await expect(run(['workflows', 'list'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('workflows get (definition + steps)', () => {
  it('lists steps in execution order in plain mode', async () => {
    stubFetch({ 'GET /api/workflows/definitions/wfdef-1': jsonResponse(DEF) })
    await run(['workflows', 'get', 'wfdef-1'])
    expect(stdout()).toBe('Fetch\tcollector\t\nDraft\twriter\tfetch\n')
  })
})

describe('workflows delete', () => {
  it('deletes with --yes', async () => {
    const calls = stubFetch({ 'DELETE /api/workflows/definitions/wfdef-1': jsonResponse({}) })
    await run(['workflows', 'delete', 'wfdef-1', '--yes'])
    expect(calls.map((c) => c.method)).toEqual(['DELETE'])
  })

  it('refuses without --yes in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['workflows', 'delete', 'wfdef-1'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('workflows runs', () => {
  it('emits raw JSON with --json and sends the default limit', async () => {
    const calls = stubFetch({ 'GET /api/workflows/runs?limit=10': jsonResponse([RUN]) })
    await run(['--json', 'workflows', 'runs'])
    expect(JSON.parse(stdout())).toEqual([RUN])
    expect(calls[0].path).toBe('/api/workflows/runs?limit=10')
  })

  it('passes status and limit through as query params', async () => {
    const calls = stubFetch({ 'GET /api/workflows/runs?status=running&limit=5': jsonResponse([]) })
    await run(['workflows', 'runs', '--status', 'running', '--limit', '5'])
    expect(calls[0].path).toBe('/api/workflows/runs?status=running&limit=5')
  })

  it('rejects --limit 0 like the other list commands', async () => {
    const calls = stubFetch({})
    await expect(run(['workflows', 'runs', '--limit', '0'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })

  it('--all pages through every run and keeps the --status filter', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ({ ...RUN, id: `workflow-${i}` }))
    const calls = stubFetch({
      'GET /api/workflows/runs?status=completed&limit=200': jsonResponse(first, {
        headers: { 'X-Total-Count': '201' },
      }),
      'GET /api/workflows/runs?status=completed&limit=200&offset=200': jsonResponse([RUN], {
        headers: { 'X-Total-Count': '201' },
      }),
    })
    await run(['--json', 'workflows', 'runs', '--all', '--status', 'completed'])
    expect(JSON.parse(stdout())).toHaveLength(201)
    expect(calls.map((c) => c.path)).toEqual([
      '/api/workflows/runs?status=completed&limit=200',
      '/api/workflows/runs?status=completed&limit=200&offset=200',
    ])
  })

  it('adds --offset and hints on stderr when the server has more', async () => {
    const calls = stubFetch({
      'GET /api/workflows/runs?limit=5&offset=5': jsonResponse([RUN], {
        headers: { 'X-Total-Count': '20' },
      }),
    })
    await run(['workflows', 'runs', '--limit', '5', '--offset', '5'])
    expect(calls[0].path).toBe('/api/workflows/runs?limit=5&offset=5')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 20')
  })

  it('rejects a negative --offset', async () => {
    stubFetch({})
    await expect(run(['workflows', 'runs', '--offset', '-1'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('rejects a negative --limit', async () => {
    stubFetch({})
    await expect(run(['workflows', 'runs', '--limit', '-3'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('shows per-step status in plain mode for runs get', async () => {
    stubFetch({ 'GET /api/workflows/runs/workflow-1': jsonResponse(RUN) })
    await run(['workflows', 'runs', 'get', 'workflow-1'])
    expect(stdout()).toContain('Fetch\tcollector\tok\t0\t')
    expect(stdout()).toContain('Draft\twriter\tok\t0\t')
  })

  it('maps 404 on runs get to the not-found exit code', async () => {
    stubFetch({ 'GET /api/workflows/runs/nope': jsonResponse({ error: 'gone' }, { status: 404 }) })
    await expect(run(['workflows', 'runs', 'get', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('workflows start', () => {
  it('launches a definition by posting its nodes + prompt', async () => {
    const calls = stubFetch({
      'GET /api/workflows/definitions/wfdef-1': jsonResponse(DEF),
      'POST /api/workflows/runs': jsonResponse({ workflowRunId: 'workflow-9', status: 'pending' }),
    })
    await run(['workflows', 'start', 'wfdef-1'])
    const post = calls.find((c) => c.method === 'POST')
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ userPrompt: 'do it', nodes: NODES, autoStart: true })
    expect(stdout()).toContain('workflow-9')
  })

  it('honors --prompt override and --no-autostart', async () => {
    const calls = stubFetch({
      'GET /api/workflows/definitions/wfdef-1': jsonResponse({ ...DEF, userPrompt: '' }),
      'POST /api/workflows/runs': jsonResponse({ workflowRunId: 'workflow-9' }),
    })
    await run(['workflows', 'start', 'wfdef-1', '--prompt', 'custom', '--no-autostart'])
    const post = calls.find((c) => c.method === 'POST')
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ userPrompt: 'custom', nodes: NODES, autoStart: false })
  })

  it('errors when a definition has no prompt and none is given', async () => {
    stubFetch({ 'GET /api/workflows/definitions/wfdef-1': jsonResponse({ ...DEF, userPrompt: '' }) })
    await expect(run(['workflows', 'start', 'wfdef-1'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('hands an existing run id to the engine via /start', async () => {
    const calls = stubFetch({
      'POST /api/workflows/runs/workflow-5/start': jsonResponse({ workflowRunId: 'workflow-5', status: 'running' }),
    })
    await run(['workflows', 'start', 'workflow-5'])
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/api/workflows/runs/workflow-5/start')
    expect(stdout()).toContain('workflow-5')
  })
})

describe('workflows cancel', () => {
  it('cancels with --yes', async () => {
    const calls = stubFetch({
      'POST /api/workflows/runs/workflow-1/cancel': jsonResponse({ workflowRunId: 'workflow-1', status: 'cancelled' }),
    })
    await run(['workflows', 'cancel', 'workflow-1', '--yes'])
    expect(calls[0].path).toBe('/api/workflows/runs/workflow-1/cancel')
  })

  it('refuses without --yes in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['workflows', 'cancel', 'workflow-1'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })
})

describe('workflows repair', () => {
  it('sends an abort action', async () => {
    const calls = stubFetch({
      'POST /api/workflows/runs/workflow-1/repair': jsonResponse({ workflowRunId: 'workflow-1', ok: true }),
    })
    await run(['workflows', 'repair', 'workflow-1', '--type', 'abort'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ type: 'abort' })
  })

  it('sends a retry_node action with the node id', async () => {
    const calls = stubFetch({
      'POST /api/workflows/runs/workflow-1/repair': jsonResponse({ workflowRunId: 'workflow-1', ok: true }),
    })
    await run(['workflows', 'repair', 'workflow-1', '--type', 'retry-node', '--node', 'draft'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ type: 'retry_node', nodeId: 'draft' })
  })

  it('rejects retry-node without a node id', async () => {
    stubFetch({})
    await expect(run(['workflows', 'repair', 'workflow-1', '--type', 'retry-node'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('rejects an unsupported repair type', async () => {
    stubFetch({})
    await expect(run(['workflows', 'repair', 'workflow-1', '--type', 'replace_node'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })
})

describe('workflows schedules', () => {
  it('lists schedules in plain mode and sends the default limit', async () => {
    const calls = stubFetch({ 'GET /api/workflows/schedules?limit=10': jsonResponse([SCHED]) })
    await run(['workflows', 'schedules'])
    expect(stdout()).toBe('wfsched-1\twfdef-1\t0 2 * * *\tUTC\tactive\t-\n')
    expect(calls[0].path).toBe('/api/workflows/schedules?limit=10')
  })

  it('pauses a schedule', async () => {
    const calls = stubFetch({
      'POST /api/workflows/schedules/wfsched-1/pause': jsonResponse({ ...SCHED, status: 'paused' }),
    })
    await run(['workflows', 'schedules', 'pause', 'wfsched-1'])
    expect(calls[0].path).toBe('/api/workflows/schedules/wfsched-1/pause')
  })

  it('resumes a schedule', async () => {
    const calls = stubFetch({
      'POST /api/workflows/schedules/wfsched-1/resume': jsonResponse(SCHED),
    })
    await run(['workflows', 'schedules', 'resume', 'wfsched-1'])
    expect(calls[0].path).toBe('/api/workflows/schedules/wfsched-1/resume')
  })
})

describe('workflows tail', () => {
  const frames = [
    { type: 'snapshot', workflowRun: { ...RUN, status: 0, nodes: [{ ...NODES[0], status: 0 }, { ...NODES[1], status: 0 }] } },
    { type: 'plan_status', workflowRun: { ...RUN, status: 1, nodes: [{ ...NODES[0], status: 2 }, { ...NODES[1], status: 0 }] } },
    { type: 'plan_status', workflowRun: RUN },
  ]

  it('emits ndjson with --json and exits 0 on completion', async () => {
    stubFetch({
      'GET /api/workflows/runs/workflow-1/stream': () => streamResponse(chunkedBytes(sseFrames(frames), [9])),
      'GET /api/workflows/runs/workflow-1': jsonResponse(RUN),
    })
    await run(['--json', 'workflows', 'tail', 'workflow-1'])
    const lines = stdout().trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual(frames)
  })

  it('prints transition lines in plain mode and fails on a failed run', async () => {
    const failed = { ...RUN, status: 4, nodes: [{ ...NODES[0], status: 4 }, { ...NODES[1], status: 5 }] }
    stubFetch({
      'GET /api/workflows/runs/workflow-2/stream': () =>
        streamResponse(
          chunkedBytes(
            sseFrames([
              { type: 'snapshot', workflowRun: { ...failed, id: 'workflow-2', status: 0, nodes: NODES } },
              { type: 'plan_status', workflowRun: { ...failed, id: 'workflow-2' } },
            ]),
            [1000],
          ),
        ),
      'GET /api/workflows/runs/workflow-2': jsonResponse({ ...failed, id: 'workflow-2' }),
    })
    await expect(run(['workflows', 'tail', 'workflow-2'])).rejects.toMatchObject({ exitCode: ExitCode.Failure })
    expect(stdout()).toContain('error')
  })
})
