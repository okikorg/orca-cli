import { Command } from 'commander'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerChat } from '../../src/commands/chat.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { chunkedBytes, streamResponse } from '../helpers/sse-stream.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_' + 'k'.repeat(32)

function gwFrames(events: { event: string; data: unknown }[]): string {
  let out = ''
  events.forEach((e, i) => {
    out += `id: p:${i}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`
  })
  return out
}

function sseRoute(events: { event: string; data: unknown }[], sizes = [1000]) {
  return () => streamResponse(chunkedBytes(gwFrames(events), sizes))
}

function buildProgram(): Command {
  const program = new Command()
  program.exitOverride()
  program.option('--json', 'machine-readable JSON output')
  program.option('--context <name>')
  program.option('--api-url <url>')
  registerChat(program)
  return program
}

let out: string[]
let err: string[]
let cleanupConfig: () => Promise<void>

beforeEach(async () => {
  out = []
  err = []
  const tmp = await useTmpConfigDir()
  cleanupConfig = tmp.cleanup
  vi.stubEnv('ORCA_GATEWAY_URL', 'http://gw:8090')
  vi.stubEnv('ORCA_CHAT_KEY', KEY)
  vi.stubEnv('ORCA_TENANT', 'org_x')
  vi.stubEnv('NO_COLOR', '1')
  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    out.push(typeof s === 'string' ? s : String(s))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    err.push(typeof s === 'string' ? s : String(s))
    return true
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await cleanupConfig()
})

const doneStream = [
  { event: 'delta', data: { text: 'Hello ' } },
  { event: 'delta', data: { text: 'world' } },
  { event: 'done', data: { conversation_id: 'conv_1', public_run_id: 'prun_1', message: 'Hello world' } },
]

describe('orca chat single-shot (plain)', () => {
  it('streams plain answer text to stdout with a single trailing newline and zero ANSI', async () => {
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(doneStream, [3]) })
    await buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'say', 'hi'])
    const stdout = out.join('')
    expect(stdout).toBe('Hello world\n')
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\x1b\[/)
  })

  it('neutralizes escape sequences injected by the gateway, even when piped', async () => {
    const evil = [
      { event: 'delta', data: { text: 'safe \x1b]0;pwn\x07' } },
      { event: 'delta', data: { text: 'text\x1b[2J done' } },
      { event: 'done', data: { conversation_id: 'conv_1', message: '' } },
    ]
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(evil) })
    await buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi'])
    const stdout = out.join('')
    expect(stdout).toBe('safe text done\n')
    expect(stdout).not.toContain('\x1b')
  })

  it('prints the conversation id to stderr so scripts can capture it', async () => {
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(doneStream) })
    await buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi'])
    expect(err.join('')).toContain('conversation conv_1')
    // The answer never leaks the chat key.
    expect(out.join('') + err.join('')).not.toContain(KEY)
  })

  it('prints one named tool line and suppresses its successful completion', async () => {
    const toolStream = [
      { event: 'tool', data: { id: 'tc1', name: 'mcp__runner__read_file', status: 'running' } },
      { event: 'tool', data: { id: 'tc1', status: 'ok' } },
      ...doneStream,
    ]
    stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(toolStream) })
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
    try {
      await buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi'])
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stderr, 'isTTY', ttyDescriptor)
      else Reflect.deleteProperty(process.stderr, 'isTTY')
    }

    const toolOutput = err.join('')
    expect(toolOutput.match(/read_file/g)).toHaveLength(1)
    expect(toolOutput).not.toContain('tool tool')
    expect(toolOutput).not.toContain(' ok')
  })

  it('passes --conversation through as conversation_id', async () => {
    const calls = stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(doneStream) })
    await buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi', '--conversation', 'conv_prev'])
    expect(JSON.parse(calls[0].body!)).toMatchObject({ message: 'hi', conversation_id: 'conv_prev' })
  })

  it('reads the message from piped stdin when no prompt arg is given', async () => {
    const calls = stubFetch({ 'POST /v1/chat/org_x/support/stream': sseRoute(doneStream) })
    const original = process.stdin
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([Buffer.from('summarize this\n')]),
      configurable: true,
    })
    try {
      await buildProgram().parseAsync(['node', 'orca', 'chat', 'support'])
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true })
    }
    expect(JSON.parse(calls[0].body!)).toMatchObject({ message: 'summarize this' })
    expect(out.join('')).toBe('Hello world\n')
  })
})

describe('orca chat single-shot (--json)', () => {
  it('emits one ndjson object per gateway event, skipping heartbeats', async () => {
    const withPing = () =>
      streamResponse(
        chunkedBytes(
          'event: delta\ndata: {"text":"Hi"}\n\n: ping\n\nevent: done\ndata: {"conversation_id":"conv_9","message":"Hi"}\n\n',
          [1000],
        ),
      )
    stubFetch({ 'POST /v1/chat/org_x/support/stream': withPing })
    await buildProgram().parseAsync(['node', 'orca', '--json', 'chat', 'support', 'hi'])
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { event: 'delta', data: { text: 'Hi' } },
      { event: 'done', data: { conversation_id: 'conv_9', message: 'Hi' } },
    ])
  })
})

describe('orca chat exit codes', () => {
  it('exits 1 on a terminal gateway error event', async () => {
    stubFetch({
      'POST /v1/chat/org_x/support/stream': sseRoute([
        { event: 'delta', data: { text: 'partial' } },
        { event: 'error', data: { code: 'upstream', message: 'conductor failed mid-run' } },
      ]),
    })
    await expect(
      buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Failure })
  })

  it('exits 3 (auth) on a 401 from the gateway', async () => {
    stubFetch({
      'POST /v1/chat/org_x/support/stream': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(
      buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })

  it('exits 4 (not found) on a 404 from the gateway', async () => {
    stubFetch({
      'POST /v1/chat/org_x/nope/stream': jsonResponse({ error: 'not_found' }, { status: 404 }),
    })
    await expect(
      buildProgram().parseAsync(['node', 'orca', 'chat', 'nope', 'hi']),
    ).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })

  it('exits 3 (auth) when no chat key is configured', async () => {
    vi.stubEnv('ORCA_CHAT_KEY', '')
    await expect(
      buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })

  it('exits 2 (usage) when no tenant is configured', async () => {
    vi.stubEnv('ORCA_TENANT', '')
    await expect(
      buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('falls back to the baked-in production gateway when none is configured', async () => {
    vi.stubEnv('ORCA_GATEWAY_URL', '')
    const calls = stubFetch({
      'POST /v1/chat/org_x/support/stream': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(
      buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Auth })
    // The request must have targeted the baked-in default host.
    expect(calls[0].host).toBe('chat-gateway-production-b766.up.railway.app')
  })
})

describe('orca chat missing agent (non-interactive)', () => {
  it('errors with a usage exit code when the agent arg is omitted and stdin is not a TTY', async () => {
    // The picker only opens in an interactive TTY; the non-TTY path keeps the
    // byte-identical missing-arg usage error so scripts and CI stay unchanged.
    stubFetch({})
    await expect(buildProgram().parseAsync(['node', 'orca', 'chat'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('errors with a usage exit code when the agent arg is omitted under --json', async () => {
    stubFetch({})
    await expect(
      buildProgram().parseAsync(['node', 'orca', '--json', 'chat']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('orca chat tenant resolution', () => {
  it('resolves the tenant by paging the published set when the slug is past the first page', async () => {
    // No ORCA_TENANT, but a conductor key is configured, so the arg is treated
    // as a slug and resolved by walking every page of the published set.
    vi.stubEnv('ORCA_TENANT', '')
    vi.stubEnv('ORCA_API_URL', 'http://api:8080')
    vi.stubEnv('ORCA_API_KEY', 'ao_dev_' + 'k'.repeat(30))
    const firstPub = Array.from({ length: 200 }, (_, i) => ({
      profileName: `p${i}`,
      slug: `slug${i}`,
      tenantId: 'org_a',
      publicUrl: 'https://x',
    }))
    const hit = { profileName: 'support', slug: 'support', tenantId: 'org_z', publicUrl: 'https://x' }
    const calls = stubFetch({
      'GET /api/profiles/support/published': jsonResponse({ error: 'not published' }, { status: 404 }),
      'GET /api/published?limit=200': jsonResponse({ publishedAgents: firstPub, total: 201 }),
      'GET /api/published?limit=200&offset=200': jsonResponse({ publishedAgents: [hit], total: 201 }),
      'POST /v1/chat/org_z/support/stream': sseRoute(doneStream),
    })
    await buildProgram().parseAsync(['node', 'orca', 'chat', 'support', 'hi'])
    expect(out.join('')).toBe('Hello world\n')
    // The gateway request landed on the tenant resolved from the second page.
    expect(calls.some((c) => c.path === '/api/published?limit=200&offset=200')).toBe(true)
    expect(calls.some((c) => c.path === '/v1/chat/org_z/support/stream')).toBe(true)
  })
})
