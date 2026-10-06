import { describe, expect, it } from 'vitest'

import { registerKeys } from '../../src/commands/keys.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const SECRET = 'orca_sk_' + 'z'.repeat(52)

function key(id: string, name = 'ci') {
  return {
    id,
    object: 'api_key',
    name,
    role: 'admin',
    hint: 'zzzz',
    created_by: 'user_1',
    created_at: 1_783_245_600,
    last_used_at: null,
  }
}

const { run, stdout, stderr } = commandHarness(registerKeys)

describe('keys', () => {
  it('lists keys in plain mode', async () => {
    stubFetch({ 'GET /api/keys?limit=10': jsonResponse(list([key('key_2', 'website'), key('key_1')])) })
    await run(['keys', 'list'])
    expect(stdout()).toBe(
      'key_2\twebsite\tadmin\t2026-07-05 10:00\t-\n' +
        'key_1\tci\tadmin\t2026-07-05 10:00\t-\n',
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
