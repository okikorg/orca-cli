import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerMcp } from '../../src/commands/mcp.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerMcp(program)
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

describe('mcp list', () => {
  it('emits raw catalog entries with --json and sends the default limit', async () => {
    const calls = stubFetch({
      'GET /api/mcp-servers?limit=10': jsonResponse([
        { name: 'github', transport: 'http', url: 'https://mcp.github.example' },
      ]),
    })
    await run(['--json', 'mcp', 'list'])
    expect(JSON.parse(stdout())).toEqual([
      { name: 'github', transport: 'http', url: 'https://mcp.github.example' },
    ])
    expect(calls[0].path).toBe('/api/mcp-servers?limit=10')
  })

  it('prints tab-separated rows in plain mode', async () => {
    stubFetch({
      'GET /api/mcp-servers?limit=10': jsonResponse([
        { name: 'github', transport: 'http', url: 'https://mcp.github.example', description: 'gh' },
        { name: 'events', transport: 'sse', url: 'https://events.example/sse' },
      ]),
    })
    await run(['mcp', 'list'])
    expect(stdout()).toBe(
      'github\thttp\thttps://mcp.github.example\tgh\n' +
        'events\tsse\thttps://events.example/sse\t-\n',
    )
  })

  it('forwards --limit/--offset and hints on stderr when the server has more', async () => {
    const calls = stubFetch({
      'GET /api/mcp-servers?limit=1&offset=3': jsonResponse(
        [{ name: 'github', transport: 'http', url: 'https://mcp.github.example' }],
        { headers: { 'X-Total-Count': '7' } },
      ),
    })
    await run(['mcp', 'list', '--limit', '1', '--offset', '3'])
    expect(calls[0].path).toBe('/api/mcp-servers?limit=1&offset=3')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('Showing 1 of 7')
  })

  it('reports an empty catalog to stderr, nothing on stdout', async () => {
    stubFetch({ 'GET /api/mcp-servers?limit=10': jsonResponse([]) })
    await run(['mcp', 'list'])
    expect(stdout()).toBe('')
    expect(vi.mocked(console.error).mock.calls.join(' ')).toContain('No MCP servers')
  })
})

describe('mcp get', () => {
  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/mcp-servers/nope': jsonResponse({ error: 'mcp server "nope" not found' }, { status: 404 }),
    })
    await expect(run(['mcp', 'get', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('mcp add', () => {
  it('posts the new catalog entry', async () => {
    const calls = stubFetch({
      'POST /api/mcp-servers': jsonResponse(
        { name: 'github', transport: 'http', url: 'https://mcp.github.example' },
        { status: 201 },
      ),
    })
    await run([
      'mcp',
      'add',
      '--name',
      'github',
      '--url',
      'https://mcp.github.example',
      '--header',
      'Authorization=Bearer x',
    ])
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body).toEqual({
      name: 'github',
      transport: 'http',
      url: 'https://mcp.github.example',
      headers: { Authorization: 'Bearer x' },
    })
  })

  it('rejects a TOML-unsafe name before any network call', async () => {
    const calls = stubFetch({})
    await expect(
      run(['mcp', 'add', '--name', 'bad name!', '--url', 'https://ok.example/mcp']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('rejects the reserved name "runner"', async () => {
    const calls = stubFetch({})
    await expect(
      run(['mcp', 'add', '--name', 'runner', '--url', 'https://ok.example/mcp']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-http url before any network call', async () => {
    const calls = stubFetch({})
    await expect(
      run(['mcp', 'add', '--name', 'svc', '--url', 'ftp://example.com/mcp']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('maps a 409 duplicate to the usage exit code with a hint', async () => {
    stubFetch({
      'POST /api/mcp-servers': jsonResponse({ error: 'already exists' }, { status: 409 }),
    })
    await expect(
      run(['mcp', 'add', '--name', 'github', '--url', 'https://mcp.github.example']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})

describe('mcp set', () => {
  it('reads then writes only the changed field', async () => {
    const calls = stubFetch({
      'GET /api/mcp-servers/github': jsonResponse({
        name: 'github',
        transport: 'http',
        url: 'https://old.example/mcp',
        description: 'gh',
      }),
      'PUT /api/mcp-servers/github': jsonResponse({
        name: 'github',
        transport: 'http',
        url: 'https://new.example/mcp',
        description: 'gh',
      }),
    })
    await run(['mcp', 'set', 'github', '--url', 'https://new.example/mcp'])
    const put = calls.find((c) => c.method === 'PUT')
    expect(put).toBeTruthy()
    const body = JSON.parse(put?.body ?? '{}')
    expect(body).toEqual({
      name: 'github',
      transport: 'http',
      url: 'https://new.example/mcp',
      description: 'gh',
    })
  })

  it('errors when no fields are supplied', async () => {
    const calls = stubFetch({})
    await expect(run(['mcp', 'set', 'github'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('mcp remove', () => {
  it('refuses without --yes when not interactive', async () => {
    stubFetch({})
    await expect(run(['mcp', 'remove', 'github'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({
      'DELETE /api/mcp-servers/github': () => new Response(null, { status: 204 }),
    })
    await run(['mcp', 'remove', 'github', '--yes'])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
  })

  it('maps a 404 on delete to the not-found exit code', async () => {
    stubFetch({
      'DELETE /api/mcp-servers/nope': jsonResponse({ error: 'not found' }, { status: 404 }),
    })
    await expect(run(['mcp', 'remove', 'nope', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('mcp test', () => {
  it('probes a registered entry and returns its result as json', async () => {
    stubFetch({
      'GET /api/mcp-servers/github': jsonResponse({
        name: 'github',
        transport: 'http',
        url: 'https://mcp.github.example',
      }),
      'POST /api/mcp-servers/test': jsonResponse({ ok: true, latencyMs: 42, toolCount: 3 }),
    })
    await run(['--json', 'mcp', 'test', 'github'])
    expect(JSON.parse(stdout())).toEqual({ ok: true, latencyMs: 42, toolCount: 3 })
  })

  it('exits non-zero when the probe fails', async () => {
    stubFetch({
      'GET /api/mcp-servers/github': jsonResponse({
        name: 'github',
        transport: 'http',
        url: 'https://mcp.github.example',
      }),
      'POST /api/mcp-servers/test': jsonResponse({ ok: false, error: 'boom', latencyMs: 10 }),
    })
    await expect(run(['--json', 'mcp', 'test', 'github'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
    })
  })

  it('probes an ad-hoc --url without touching the catalog', async () => {
    const calls = stubFetch({
      'POST /api/mcp-servers/test': jsonResponse({ ok: true, latencyMs: 5 }),
    })
    await run(['--json', 'mcp', 'test', '--url', 'https://probe.example/mcp', '--transport', 'sse'])
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body.transport).toBe('sse')
    expect(body.url).toBe('https://probe.example/mcp')
  })
})

describe('mcp attach', () => {
  it('copies the catalog entry into the profile, leaving the rest untouched', async () => {
    const calls = stubFetch({
      'GET /api/mcp-servers/github': jsonResponse({
        name: 'github',
        transport: 'http',
        url: 'https://mcp.github.example',
        description: 'gh catalog note',
      }),
      'GET /api/profiles/support-bot': jsonResponse({
        name: 'support-bot',
        runtime: 'claude',
        systemPrompt: 'be helpful',
        mcpServers: [{ name: 'existing', transport: 'sse', url: 'https://existing.example/sse' }],
      }),
      'PUT /api/profiles/support-bot': jsonResponse({ name: 'support-bot', runtime: 'claude' }),
    })
    await run(['mcp', 'attach', 'support-bot', 'github'])
    const put = calls.find((c) => c.method === 'PUT')
    const body = JSON.parse(put?.body ?? '{}')
    // Rest of the profile is preserved.
    expect(body.name).toBe('support-bot')
    expect(body.runtime).toBe('claude')
    expect(body.systemPrompt).toBe('be helpful')
    // Existing server kept, new one appended without the catalog description.
    expect(body.mcpServers).toEqual([
      { name: 'existing', transport: 'sse', url: 'https://existing.example/sse' },
      { name: 'github', transport: 'http', url: 'https://mcp.github.example' },
    ])
  })

  it('rejects a duplicate server name on the profile', async () => {
    stubFetch({
      'GET /api/mcp-servers/github': jsonResponse({
        name: 'github',
        transport: 'http',
        url: 'https://mcp.github.example',
      }),
      'GET /api/profiles/support-bot': jsonResponse({
        name: 'support-bot',
        runtime: 'claude',
        mcpServers: [{ name: 'github', transport: 'http', url: 'https://old.example/mcp' }],
      }),
    })
    await expect(run(['mcp', 'attach', 'support-bot', 'github'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('maps an unknown agent to the not-found exit code', async () => {
    stubFetch({
      'GET /api/mcp-servers/github': jsonResponse({
        name: 'github',
        transport: 'http',
        url: 'https://mcp.github.example',
      }),
      'GET /api/profiles/ghost': jsonResponse({ error: 'unknown_profile: ghost' }, { status: 404 }),
    })
    await expect(run(['mcp', 'attach', 'ghost', 'github'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})

describe('mcp detach', () => {
  it('removes the named server with --yes', async () => {
    const calls = stubFetch({
      'GET /api/profiles/support-bot': jsonResponse({
        name: 'support-bot',
        runtime: 'claude',
        mcpServers: [
          { name: 'github', transport: 'http', url: 'https://mcp.github.example' },
          { name: 'keep', transport: 'sse', url: 'https://keep.example/sse' },
        ],
      }),
      'PUT /api/profiles/support-bot': jsonResponse({ name: 'support-bot', runtime: 'claude' }),
    })
    await run(['mcp', 'detach', 'support-bot', 'github', '--yes'])
    const put = calls.find((c) => c.method === 'PUT')
    const body = JSON.parse(put?.body ?? '{}')
    expect(body.mcpServers).toEqual([
      { name: 'keep', transport: 'sse', url: 'https://keep.example/sse' },
    ])
  })

  it('maps a server not on the profile to the not-found exit code', async () => {
    stubFetch({
      'GET /api/profiles/support-bot': jsonResponse({
        name: 'support-bot',
        runtime: 'claude',
        mcpServers: [{ name: 'keep', transport: 'sse', url: 'https://keep.example/sse' }],
      }),
    })
    await expect(
      run(['mcp', 'detach', 'support-bot', 'github', '--yes']),
    ).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })
})
