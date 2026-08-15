import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerPlatform, renderTopologyTree } from '../../src/commands/platform.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { ansi, glyphs } from '../../src/ui/theme.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// Mirrors agent-runtime/runtime/remote/pool.go RunnerTopology (:53).
const TOPOLOGY = [
  { hash: 'a1b2c3d', url: 'http://runner-1:9090', healthy: true, latencyMs: 12, activeSessions: 2 },
  {
    hash: 'e4f5a6b',
    url: 'http://runner-2:9090',
    healthy: false,
    activeSessions: 0,
    error: 'connection refused',
  },
]

// Mirrors runtime/toolkit/toolkit.go CapabilityBundleInfo (:134).
const BUNDLES = {
  bundles: [
    { value: '@default', label: 'Default', description: 'Safe baseline: introspection, fs, pool.' },
    { value: '@fs', label: 'File System', description: 'Read/write the per-agent file system.' },
  ],
}

// Mirrors connected_apps.go providerDTO (:69) and connections_repo.go AppConnection (:23).
const PROVIDERS = { providers: [{ name: 'composio', configured: true }] }
const CONNECTIONS = {
  connections: [
    {
      id: 'conn_1',
      provider: 'composio',
      appSlug: 'github',
      scope: 'tenant',
      status: 'ACTIVE',
      mcpServerName: 'composio-github',
      createdAt: '2026-07-05T00:00:00Z',
    },
  ],
}

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerPlatform(program)
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

describe('platform command registration', () => {
  it('does not expose the removed ping command', () => {
    const program = new Command()
    registerPlatform(program)
    expect(program.commands.map((command) => command.name())).toEqual([
      'topology',
      'bundles',
      'apps',
    ])
  })
})

describe('renderTopologyTree', () => {
  it('draws a conductor root, tree-branch connectors, and per-runner health', () => {
    const s = renderTopologyTree(TOPOLOGY, { color: false })
    const lines = s.split('\n')
    expect(lines[0]).toBe('conductor  2 runners, 1 healthy')
    // The edge connector is the active tier's tree-branch glyph, never hardcoded.
    expect(lines[1]).toContain(`${glyphs.treeBranch} `)
    expect(lines[1]).toContain('a1b2c3d')
    expect(lines[1]).toContain('healthy')
    expect(lines[1]).toContain('2 sessions')
    expect(lines[1]).toContain('12ms')
    expect(lines[2]).toContain('e4f5a6b')
    expect(lines[2]).toContain('down')
    expect(lines[2]).toContain('connection refused')
  })

  it('emits no ANSI escapes when color is disabled', () => {
    // eslint-disable-next-line no-control-regex
    expect(renderTopologyTree(TOPOLOGY, { color: false })).not.toMatch(/\x1b\[/)
  })

  it('emits coral ANSI on the conductor node when color is enabled', () => {
    expect(renderTopologyTree(TOPOLOGY, { color: true })).toContain(ansi.accent)
  })

  it('handles an empty pool without throwing', () => {
    const s = renderTopologyTree([], { color: false })
    expect(s).toContain('0 runners, 0 healthy')
    expect(s).toContain('(no runners registered)')
  })
})

describe('topology', () => {
  it('emits the raw runner array with --json', async () => {
    stubFetch({ 'GET /api/topology': jsonResponse(TOPOLOGY) })
    await run(['--json', 'topology'])
    expect(JSON.parse(stdout())).toEqual(TOPOLOGY)
  })

  it('prints one tab-separated row per runner in plain mode', async () => {
    stubFetch({ 'GET /api/topology': jsonResponse(TOPOLOGY) })
    await run(['topology'])
    expect(stdout()).toBe(
      'a1b2c3d\thttp://runner-1:9090\thealthy\t2\t12\t\n' +
        'e4f5a6b\thttp://runner-2:9090\tdown\t0\t\tconnection refused\n',
    )
  })

  it('maps single-runner-mode 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/topology': jsonResponse(
        { error: 'topology unavailable: server is not in pooled-conductor mode' },
        { status: 404 },
      ),
    })
    await expect(run(['topology'])).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })
})

describe('bundles', () => {
  it('emits the unwrapped bundle array with --json', async () => {
    stubFetch({ 'GET /api/capability-bundles': jsonResponse(BUNDLES) })
    await run(['--json', 'bundles'])
    expect(JSON.parse(stdout())).toEqual(BUNDLES.bundles)
  })

  it('prints value/label/description rows in plain mode', async () => {
    stubFetch({ 'GET /api/capability-bundles': jsonResponse(BUNDLES) })
    await run(['bundles'])
    expect(stdout()).toBe(
      '@default\tDefault\tSafe baseline: introspection, fs, pool.\n' +
        '@fs\tFile System\tRead/write the per-agent file system.\n',
    )
  })

  it('maps a 401 to the auth exit code', async () => {
    stubFetch({
      'GET /api/capability-bundles': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['bundles'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})

describe('apps', () => {
  it('emits providers and connections with --json', async () => {
    stubFetch({
      'GET /api/connected-apps/providers': jsonResponse(PROVIDERS),
      'GET /api/connected-apps/connections': jsonResponse(CONNECTIONS),
    })
    await run(['--json', 'apps'])
    expect(JSON.parse(stdout())).toEqual({
      providers: PROVIDERS.providers,
      connections: CONNECTIONS.connections,
    })
  })

  it('degrades to empty lists when the registry is not configured (503)', async () => {
    stubFetch({
      'GET /api/connected-apps/providers': jsonResponse(
        { error: 'connected apps registry not configured' },
        { status: 503 },
      ),
      'GET /api/connected-apps/connections': jsonResponse({ connections: [] }),
    })
    await run(['--json', 'apps'])
    expect(JSON.parse(stdout())).toEqual({ providers: [], connections: [] })
  })

  it('prints discriminated rows in plain mode', async () => {
    stubFetch({
      'GET /api/connected-apps/providers': jsonResponse(PROVIDERS),
      'GET /api/connected-apps/connections': jsonResponse(CONNECTIONS),
    })
    await run(['apps'])
    expect(stdout()).toBe(
      'provider\tcomposio\tconfigured\n' + 'connection\tconn_1\tcomposio\tgithub\tACTIVE\n',
    )
  })

  it('maps a 401 on providers to the auth exit code', async () => {
    stubFetch({
      'GET /api/connected-apps/providers': jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(run(['apps'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })
})
