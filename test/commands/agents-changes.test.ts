import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerAgents } from '../../src/commands/agents.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'

// Mirrors agent-runtime/runtime/httpapi/profile_changes.go profileChangeDTO
// (:27) as returned by GET /api/profiles/{name}/changes (a raw array, newest
// first).
const CHANGES = [
  {
    id: 'chg-002',
    profile: 'support-bot',
    action: 'updated',
    at: '2026-07-05T10:00:00Z',
    fields: ['model', 'skills'],
  },
  {
    id: 'chg-001',
    profile: 'support-bot',
    action: 'created',
    at: '2026-07-04T09:00:00Z',
    fields: ['profile'],
  },
]

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerAgents(program)
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

describe('agents changes', () => {
  it('emits the raw change array with --json', async () => {
    stubFetch({ 'GET /api/profiles/support-bot/changes': jsonResponse(CHANGES) })
    await run(['--json', 'agents', 'changes', 'support-bot'])
    expect(JSON.parse(stdout())).toEqual(CHANGES)
  })

  it('prints one tab-separated row per change in plain mode', async () => {
    stubFetch({ 'GET /api/profiles/support-bot/changes': jsonResponse(CHANGES) })
    await run(['agents', 'changes', 'support-bot'])
    expect(stdout()).toBe(
      '2026-07-05 10:00\tupdated\tmodel, skills\tchg-002\n' +
        '2026-07-04 09:00\tcreated\tprofile\tchg-001\n',
    )
  })

  it('caps the result set with --limit', async () => {
    stubFetch({ 'GET /api/profiles/support-bot/changes': jsonResponse(CHANGES) })
    await run(['--json', 'agents', 'changes', 'support-bot', '--limit', '1'])
    const out = JSON.parse(stdout())
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('chg-002')
  })

  it('rejects a non-positive --limit with the usage exit code', async () => {
    stubFetch({ 'GET /api/profiles/support-bot/changes': jsonResponse(CHANGES) })
    await expect(
      run(['agents', 'changes', 'support-bot', '--limit', '0']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('URL-encodes the profile name in the path', async () => {
    const calls = stubFetch({
      'GET /api/profiles/my%2Fbot/changes': jsonResponse([]),
    })
    await run(['--json', 'agents', 'changes', 'my/bot'])
    expect(calls[0].path).toBe('/api/profiles/my%2Fbot/changes')
  })

  it('maps a 404 to the not-found exit code', async () => {
    stubFetch({
      'GET /api/profiles/nope/changes': jsonResponse({ error: 'unknown profile' }, { status: 404 }),
    })
    await expect(run(['agents', 'changes', 'nope'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })
})
