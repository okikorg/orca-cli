import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { registerVaults } from '../../src/commands/vaults.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const VAULT = { id: 'vault_1', object: 'vault', name: 'partner-api', metadata: {}, created_at: 1_783_245_600 }
const CREDENTIAL = {
  id: 'cred_1',
  object: 'vault.credential',
  vault_id: 'vault_1',
  name: 'access',
  auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com' },
  created_at: 1_783_245_600,
  updated_at: 1_783_245_600,
}

const { run, stdout, stderr } = commandHarness(registerVaults)

describe('vaults', () => {
  it('lists vaults', async () => {
    stubFetch({ 'GET /v1/vaults?limit=10': jsonResponse(list([VAULT])) })
    await run(['vaults', 'list'])
    expect(stdout()).toBe('vault_1\tpartner-api\t2026-07-05 10:00\n')
  })

  it('creates and deletes a vault', async () => {
    const calls = stubFetch({
      'POST /v1/vaults': jsonResponse(VAULT),
      'DELETE /v1/vaults/vault_1': jsonResponse({ id: 'vault_1', object: 'vault.deleted', deleted: true }),
    })
    await run(['vaults', 'create', 'partner-api'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ name: 'partner-api' })
    await expect(run(['vaults', 'delete', 'vault_1'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    await run(['vaults', 'delete', 'vault_1', '--yes'])
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
  })

  it('lists credentials without any value', async () => {
    stubFetch({ 'GET /v1/vaults/vault_1/credentials?limit=10': jsonResponse(list([CREDENTIAL])) })
    await run(['vaults', 'credentials', 'list', 'vault_1'])
    expect(stdout()).toBe('cred_1\taccess\tstatic_bearer\thttps://mcp.example.com\t2026-07-05 10:00\n')
  })

  it('adds a bearer credential with the token from stdin, never echoing it', async () => {
    const calls = stubFetch({ 'POST /v1/vaults/vault_1/credentials': jsonResponse(CREDENTIAL) })
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      () => Readable.from([Buffer.from('tok-secret\n')])[Symbol.asyncIterator]() as never,
    )
    await run(['vaults', 'credentials', 'add', 'vault_1', '--name', 'access', '--server', 'https://mcp.example.com'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
      name: 'access',
      auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com', token: 'tok-secret' },
    })
    expect(stdout() + stderr()).not.toContain('tok-secret')
  })

  it('refuses an empty piped token', async () => {
    const calls = stubFetch({})
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      () => Readable.from([Buffer.from('\n')])[Symbol.asyncIterator]() as never,
    )
    await expect(
      run(['vaults', 'credentials', 'add', 'vault_1', '--name', 'access', '--server', 'https://mcp.example.com']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('maps the admin-only refusal to the auth exit code', async () => {
    stubFetch({
      'POST /v1/vaults': jsonResponse(
        { error: { message: 'This action requires the admin role', code: 'permission_denied' } },
        { status: 403 },
      ),
    })
    await expect(run(['vaults', 'create', 'x'])).rejects.toMatchObject({ exitCode: ExitCode.Auth })
  })

  it('deletes a credential from its vault', async () => {
    const calls = stubFetch({
      'DELETE /v1/vaults/vault_1/credentials/cred_1': jsonResponse({ id: 'cred_1', deleted: true }),
    })
    await run(['vaults', 'credentials', 'delete', 'vault_1', 'cred_1', '--yes'])
    expect(calls).toHaveLength(1)
  })
})
