import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerRuns } from '../../src/commands/runs.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { chunkedBytes, sseFrames, streamResponse } from '../helpers/sse-stream.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program
    .exitOverride()
    .option('--context <name>')
    .option('--api-url <url>')
    .option('--json')
  registerRuns(program)
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

const SUMMARY = {
  id: 'run_1',
  subTask: { profile: 'support-bot', title: 't' },
  status: 'ok',
  startedAt: '2026-07-05T10:00:00Z',
  finishedAt: '2026-07-05T10:00:30Z',
}

describe('runs list', () => {
  it('prints tab-separated rows in plain mode and sends the default limit', async () => {
    const calls = stubFetch({ 'GET /api/runs?limit=10': jsonResponse([SUMMARY]) })
    await run(['runs', 'list'])
    expect(stdout()).toBe('run_1\tsupport-bot\tok\t2026-07-05 10:00\t30s\n')
    expect(calls[0].path).toBe('/api/runs?limit=10')
  })

  it('passes --limit/--offset through to the server', async () => {
    const calls = stubFetch({ 'GET /api/runs?limit=5&offset=10': jsonResponse([SUMMARY]) })
    await run(['runs', 'list', '--limit', '5', '--offset', '10'])
    expect(calls[0].path).toBe('/api/runs?limit=5&offset=10')
  })

  it('filters by agent via the profile runs endpoint', async () => {
    const calls = stubFetch({ 'GET /api/profiles/support-bot/runs?limit=10': jsonResponse([SUMMARY]) })
    await run(['runs', 'list', '--agent', 'support-bot'])
    expect(calls).toHaveLength(1)
  })

  it('emits a raw array with --json and no hint', async () => {
    stubFetch({
      'GET /api/runs?limit=10': jsonResponse([SUMMARY], { headers: { 'X-Total-Count': '99' } }),
    })
    await run(['--json', 'runs', 'list'])
    expect(JSON.parse(stdout())).toEqual([SUMMARY])
  })

  it('prints the "Showing X of Y" hint on stderr when the server has more', async () => {
    stubFetch({
      'GET /api/runs?limit=10': jsonResponse([SUMMARY], { headers: { 'X-Total-Count': '99' } }),
    })
    await run(['runs', 'list'])
    expect(stdout()).toBe('run_1\tsupport-bot\tok\t2026-07-05 10:00\t30s\n')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 99')
  })
})

describe('runs get', () => {
  it('prints plain label/value lines and the event transcript (non-TTY)', async () => {
    stubFetch({
      'GET /api/runs/run_1': jsonResponse({
        ...SUMMARY,
        events: [
          { type: 'assistant', message: 'hi there' },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
      }),
    })
    await run(['runs', 'get', 'run_1'])
    const out = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')
    expect(out).toContain('Run:      run_1')
    expect(out).toContain('Agent:    support-bot')
    expect(out).toContain('Status:   ok')
    expect(out).toContain('hi there')
    expect(out).toContain('Tokens:   in 10 out 5')
  })

  it('emits the raw run with --json', async () => {
    stubFetch({ 'GET /api/runs/run_1': jsonResponse({ ...SUMMARY, events: [] }) })
    await run(['--json', 'runs', 'get', 'run_1'])
    expect(JSON.parse(stdout())).toEqual({ ...SUMMARY, events: [] })
  })

  it('requires a run id in non-interactive mode (the picker only opens in a TTY)', async () => {
    // The arg is now optional so a TTY can open the run picker; without a
    // terminal the missing id stays a usage error (exit 2), unchanged.
    stubFetch({})
    await expect(run(['runs', 'get'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('runs tail', () => {
  const events = [
    { type: 'assistant', message: 'hello' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'result', message: 'done' },
  ]

  it('emits ndjson with --json and exits 0 on ok', async () => {
    stubFetch({
      'GET /api/runs/run_1/stream': () => streamResponse(chunkedBytes(sseFrames(events), [9])),
      'GET /api/runs/run_1': jsonResponse({ ...SUMMARY, events: [] }),
    })
    await run(['--json', 'runs', 'tail', 'run_1'])
    const lines = stdout().trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual(events)
  })

  it('prints formatted lines in plain mode and fails on error status', async () => {
    stubFetch({
      'GET /api/runs/run_2/stream': () =>
        streamResponse(chunkedBytes(sseFrames([{ type: 'error', message: 'boom' }]), [1000])),
      'GET /api/runs/run_2': jsonResponse({ ...SUMMARY, id: 'run_2', status: 'error', events: [] }),
    })
    await expect(run(['runs', 'tail', 'run_2'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
    })
    expect(stdout()).toContain('error: boom')
  })

  it('requires a run id in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['runs', 'tail'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('runs cancel', () => {
  it('cancels the run and confirms on stdout in plain mode', async () => {
    const calls = stubFetch({ 'DELETE /api/runs/run_1': jsonResponse({}) })
    await run(['runs', 'cancel', 'run_1'])
    expect(calls[0].path).toBe('/api/runs/run_1')
    expect(vi.mocked(console.log).mock.calls.join(' ')).toContain('run_1')
  })

  it('emits the cancelled id with --json', async () => {
    stubFetch({ 'DELETE /api/runs/run_1': jsonResponse({}) })
    await run(['--json', 'runs', 'cancel', 'run_1'])
    expect(JSON.parse(stdout())).toEqual({ id: 'run_1', cancelled: true })
  })

  it('requires a run id in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['runs', 'cancel'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('run (create + tail)', () => {
  it('creates the run and tails it to completion', async () => {
    const calls = stubFetch({
      'POST /api/runs': jsonResponse({ runId: 'run_9', sessionId: 'sess_9' }),
      'GET /api/runs/run_9/stream': () =>
        streamResponse(chunkedBytes(sseFrames([{ type: 'result', message: 'hi' }]), [1000])),
      'GET /api/runs/run_9': jsonResponse({ ...SUMMARY, id: 'run_9', events: [] }),
    })
    await run(['run', 'support-bot', 'say', 'hi'])
    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body).toEqual({ profile: 'support-bot', title: 'say hi', prompt: 'say hi' })
    expect(stdout()).toContain('hi')
  })

  it('prints only the run id on stdout with --detach', async () => {
    stubFetch({ 'POST /api/runs': jsonResponse({ runId: 'run_5', sessionId: 's' }) })
    await run(['run', 'support-bot', 'go', '--detach'])
    expect(stdout()).toBe('run_5\n')
  })

  it('requires agent and prompt in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['run'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})
