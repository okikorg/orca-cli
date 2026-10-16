import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { registerVaults } from '../../src/commands/vaults.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { VAULT_ID, vault, vaultByName, vaultRoute } from '../helpers/session-events.js'

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

const BASIC = {
  ...CREDENTIAL,
  id: 'cred_2',
  vault_id: VAULT_ID,
  name: 'dataforseo',
  auth: { type: 'static_basic', mcp_server_url: 'https://mcp.dataforseo.com/mcp' },
}
const LOGIN = 'seo@acme.dev'
const PASSWORD = 'pw-hunter2-secret'
const addBasic = (vaultRef = 'dataforseo') => [
  'vaults', 'credentials', 'add', vaultRef, '--name', 'dataforseo', '--server', 'https://mcp.dataforseo.com/mcp',
]

// pipeStdin makes stdin a pipe holding text, as `printf %s "$PW" | orca` does.
function pipeStdin(text: string): void {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
    () => Readable.from([Buffer.from(text)])[Symbol.asyncIterator]() as never,
  )
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

  it('lists a login and password credential with its type', async () => {
    stubFetch({ 'GET /v1/vaults/vault_1/credentials?limit=10': jsonResponse(list([CREDENTIAL, BASIC])) })
    await run(['vaults', 'credentials', 'list', 'vault_1'])
    expect(stdout().split('\n')[1]).toBe('cred_2\tdataforseo\tstatic_basic\thttps://mcp.dataforseo.com/mcp\t2026-07-05 10:00')
  })

  it('adds a bearer credential with the token from stdin, never echoing it', async () => {
    const calls = stubFetch({
      ...vaultRoute('vault_1', 'partner-api'),
      'POST /v1/vaults/vault_1/credentials': jsonResponse(CREDENTIAL),
    })
    pipeStdin('tok-secret\n')
    await run(['vaults', 'credentials', 'add', 'vault_1', '--name', 'access', '--server', 'https://mcp.example.com'])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({
      name: 'access',
      auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com', token: 'tok-secret' },
    })
    expect(stdout() + stderr()).not.toContain('tok-secret')
  })

  it('refuses an empty piped token', async () => {
    const calls = stubFetch(vaultRoute('vault_1', 'partner-api'))
    pipeStdin('\n')
    await expect(
      run(['vaults', 'credentials', 'add', 'vault_1', '--name', 'access', '--server', 'https://mcp.example.com']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('adds a login and password through /api with --basic, the vault by name, printing neither', async () => {
    const calls = stubFetch({
      ...vaultByName('dataforseo', [vault('vault_other', 'other'), vault()]),
      [`POST /api/vaults/${VAULT_ID}/credentials`]: jsonResponse(BASIC),
    })
    pipeStdin(`${PASSWORD}\n`)
    await run([...addBasic(), '--basic', '--login', LOGIN])
    const post = calls.filter((c) => c.method === 'POST')
    expect(post.map((c) => c.path)).toEqual([`/api/vaults/${VAULT_ID}/credentials`])
    expect(JSON.parse(post[0].body ?? '{}')).toEqual({
      name: 'dataforseo',
      auth: { type: 'static_basic', mcp_server_url: 'https://mcp.dataforseo.com/mcp', login: LOGIN, password: PASSWORD },
    })
    expect(stdout()).toBe(`Added credential "dataforseo" (cred_2) to vault "dataforseo" (${VAULT_ID}).\n`)
    expect(stdout() + stderr()).not.toContain(PASSWORD)
    expect(stdout() + stderr()).not.toContain(LOGIN)
  })

  it('prints the server\'s credential with --json, which holds no login or password', async () => {
    stubFetch({ ...vaultRoute(), [`POST /api/vaults/${VAULT_ID}/credentials`]: jsonResponse(BASIC) })
    pipeStdin(PASSWORD)
    await run(['--json', ...addBasic(VAULT_ID), '--basic', '--login', LOGIN])
    expect(JSON.parse(stdout())).toEqual(BASIC)
    expect(stdout() + stderr()).not.toContain(PASSWORD)
  })

  it('never takes a password from a flag, and never prints the value given', async () => {
    const calls = stubFetch({})
    for (const flag of [['--password', PASSWORD], [`--password=${PASSWORD}`]]) {
      for (const basic of [['--basic', '--login', LOGIN], []]) {
        await expect(run([...addBasic(), ...basic, ...flag])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
      }
    }
    expect(calls).toHaveLength(0)
    expect(stdout() + stderr()).not.toContain(PASSWORD)
  })

  it('refuses --basic without --login, --token with --basic, and --login without --basic', async () => {
    const calls = stubFetch({})
    await expect(run([...addBasic(), '--basic'])).rejects.toThrow('--basic needs --login')
    await expect(run([...addBasic(), '--basic', '--login', LOGIN, '--token', PASSWORD])).rejects.toThrow('--token is for a bearer token')
    await expect(run([...addBasic(), '--login', LOGIN])).rejects.toThrow('--login needs --basic')
    expect(calls).toHaveLength(0)
    expect(stdout() + stderr()).not.toContain(PASSWORD)
  })

  it('refuses an empty piped password before anything is written', async () => {
    const calls = stubFetch(vaultRoute())
    pipeStdin('\n')
    await expect(run([...addBasic(VAULT_ID), '--basic', '--login', LOGIN])).rejects.toThrow(
      'no password provided',
    )
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
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
