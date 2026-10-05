import { describe, expect, it } from 'vitest'

import { registerKeys } from '../../src/commands/keys.js'
import { registerPublish } from '../../src/commands/publish.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const AGENT = 'agent_' + '1'.repeat(32)
const SECRET = 'orca_sk_' + 'z'.repeat(52)

function key(id: string, agent: string | null = null) {
  return {
    id,
    object: 'api_key',
    name: agent ? 'website' : 'ci',
    role: 'admin',
    hint: 'zzzz',
    created_by: 'user_1',
    created_at: 1_783_245_600,
    last_used_at: null,
    agent,
  }
}

const { run, stdout, stderr } = commandHarness(registerKeys, registerPublish)

describe('keys', () => {
  it('lists keys with their scope in plain mode', async () => {
    stubFetch({ 'GET /api/keys?limit=10': jsonResponse(list([key('key_2', AGENT), key('key_1')])) })
    await run(['keys', 'list'])
    expect(stdout()).toBe(
      `key_2\twebsite\tadmin\tagent ${AGENT}\t2026-07-05 10:00\t-\n` +
        'key_1\tci\tadmin\torganization\t2026-07-05 10:00\t-\n',
    )
  })

  it('creates a key and prints only the secret when piped', async () => {
    const calls = stubFetch({ 'POST /api/keys': jsonResponse({ ...key('key_3'), secret: SECRET }) })
    await run(['keys', 'create', 'ci'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ name: 'ci' })
    expect(stdout()).toBe(`${SECRET}\n`)
  })

  it('requires a name in non-interactive mode', async () => {
    stubFetch({})
    await expect(run(['keys', 'create'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('revokes with --yes and refuses without it', async () => {
    const calls = stubFetch({
      'DELETE /api/keys/key_1': jsonResponse({ id: 'key_1', object: 'api_key.deleted', deleted: true }),
    })
    await expect(run(['keys', 'revoke', 'key_1'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    await run(['keys', 'revoke', 'key_1', '--yes'])
    expect(calls).toHaveLength(1)
  })

  it('hints the create command on an empty list', async () => {
    stubFetch({ 'GET /api/keys?limit=10': jsonResponse(list([])) })
    await run(['keys', 'list'])
    expect(stdout()).toBe('')
    expect(stderr()).toContain('orca keys create')
  })
})

describe('publish', () => {
  it('mints a scoped key with the label and prints the secret once', async () => {
    const calls = stubFetch({
      [`POST /api/agents/${AGENT}/publish`]: jsonResponse({ ...key('key_4', AGENT), secret: SECRET }),
    })
    await run(['publish', 'create', AGENT, '--label', 'website'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ label: 'website' })
    expect(stdout()).toBe(`${SECRET}\n`)
  })

  it('needs a label', async () => {
    stubFetch({})
    await expect(run(['publish', 'create', AGENT])).rejects.toThrow()
  })

  it('explains the plan limit on published agents', async () => {
    stubFetch({
      [`POST /api/agents/${AGENT}/publish`]: jsonResponse(
        { error: { message: 'Your plan publishes 1 agents', code: 'conflict' } },
        { status: 409 },
      ),
    })
    await expect(run(['publish', 'create', AGENT, '--label', 'website'])).rejects.toMatchObject({
      message: '409: Your plan publishes 1 agents',
    })
  })

  it('lists an agent\'s published keys', async () => {
    stubFetch({ [`GET /api/agents/${AGENT}/published-keys`]: jsonResponse(list([key('key_4', AGENT)])) })
    await run(['publish', 'list', AGENT])
    expect(stdout()).toBe('key_4\twebsite\t2026-07-05 10:00\t-\n')
  })

  it('says so when an agent is not published', async () => {
    stubFetch({ [`GET /api/agents/${AGENT}/published-keys`]: jsonResponse(list([])) })
    await run(['publish', 'list', AGENT])
    expect(stderr()).toContain('is not published')
  })

  it('unpublishes by revoking the key', async () => {
    const calls = stubFetch({
      'DELETE /api/keys/key_4': jsonResponse({ id: 'key_4', object: 'api_key.deleted', deleted: true }),
    })
    await run(['publish', 'revoke', 'key_4', '--yes'])
    expect(calls[0].method).toBe('DELETE')
  })
})
