import { describe, expect, it } from 'vitest'

import { parseKitLink, registerKits } from '../../src/commands/kits.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { API, commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const PUBLIC_ID = 'kit-AbCdEfGhIjKlMnOpQ'
const AGENT = 'agent_' + '1'.repeat(32)

const KIT = {
  id: 'kit_1',
  object: 'kit',
  public_id: null as string | null,
  name: 'Support desk',
  description: 'Answers tickets',
  readme: '',
  status: 'draft',
  selection: { agents: [AGENT], skills: ['skill_1'], templates: [] },
  latest_version: null as number | null,
  created_by: 'user_1',
  created_at: 1_783_245_600,
  updated_at: 1_783_245_600,
}

const PUBLIC = {
  object: 'kit.public',
  public_id: PUBLIC_ID,
  name: 'Support desk',
  description: 'Answers tickets',
  readme: '# Support desk',
  version: 1,
  published_at: 1_783_245_600,
  contents: {
    agents: [{ key: 'agent-1', name: 'support', model: 'openai/gpt-5', team: false }],
    skills: [{ key: 'skill-1', name: 'triage', description: 'Sort tickets' }],
    templates: [],
  },
  credentials: [{ kind: 'mcp_server', name: 'docs', server_url: 'https://mcp.example.com', used_by: 'support' }],
}

const { run, stdout, stderr } = commandHarness(registerKits)

describe('parseKitLink', () => {
  it('accepts the share URL, any origin, and a bare id', () => {
    expect(parseKitLink(`https://app.orcapods.ai/kits/${PUBLIC_ID}`)).toBe(PUBLIC_ID)
    expect(parseKitLink(`http://localhost:5173/kits/${PUBLIC_ID}/?utm_source=x`)).toBe(PUBLIC_ID)
    expect(parseKitLink(` ${PUBLIC_ID} `)).toBe(PUBLIC_ID)
  })

  it('rejects anything that is not a kit link', () => {
    for (const bad of ['', 'kit-short', 'ftp://x/kits/' + PUBLIC_ID, 'https://app.orcapods.ai/kits/']) {
      expect(() => parseKitLink(bad)).toThrow(expect.objectContaining({ exitCode: ExitCode.Usage }))
    }
  })
})

describe('kits list, make, edit', () => {
  it('lists own kits', async () => {
    stubFetch({ 'GET /api/kits': jsonResponse(list([{ ...KIT, status: 'published', latest_version: 2, public_id: PUBLIC_ID }])) })
    await run(['kits', 'list'])
    expect(stdout()).toBe(`kit_1\tSupport desk\tpublished\t2\t${PUBLIC_ID}\n`)
  })

  it('makes a kit from a selection, resolving agent names', async () => {
    const calls = stubFetch({
      'GET /v1/agents?limit=100': jsonResponse(list([{ id: AGENT, name: 'support' }])),
      'POST /api/kits': jsonResponse(KIT),
    })
    await run(['kits', 'make', '--name', 'Support desk', '--description', 'Answers tickets', '--agent', 'support', '--skill', 'skill_1'])
    expect(JSON.parse(calls.find((c) => c.path === '/api/kits')?.body ?? '{}')).toEqual({
      name: 'Support desk',
      description: 'Answers tickets',
      selection: { agents: [AGENT], skills: ['skill_1'], templates: [] },
    })
  })

  it('edits only what is passed', async () => {
    const calls = stubFetch({ 'PATCH /api/kits/kit_1': jsonResponse({ ...KIT, name: 'Desk' }) })
    await run(['kits', 'edit', 'kit_1', '--name', 'Desk'])
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ name: 'Desk' })
  })

  it('refuses an edit with nothing to change', async () => {
    const calls = stubFetch({})
    await expect(run(['kits', 'edit', 'kit_1'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })
})

describe('kits publish and withdraw', () => {
  it('publishes and prints the share link on the context\'s dashboard', async () => {
    await saveConfig({
      currentContext: 'default',
      contexts: { default: { apiUrl: API, apiKey: 'orca_sk_' + 'a'.repeat(52), dashboardUrl: 'http://localhost:5173' } },
    })
    stubFetch({
      'POST /api/kits/kit_1/publish': jsonResponse({ ...KIT, status: 'published', public_id: PUBLIC_ID, latest_version: 1 }),
    })
    await run(['kits', 'publish', 'kit_1'])
    expect(stdout()).toContain(`version 1 as ${PUBLIC_ID}`)
    expect(stdout()).toContain(`Share it: http://localhost:5173/kits/${PUBLIC_ID}`)
  })

  it('withdraws', async () => {
    const calls = stubFetch({ 'POST /api/kits/kit_1/withdraw': jsonResponse({ ...KIT, status: 'withdrawn' }) })
    await run(['kits', 'withdraw', 'kit_1'])
    expect(calls).toHaveLength(1)
  })
})

describe('kits show', () => {
  it('reads the public page without a credential', async () => {
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: API } } })
    const calls = stubFetch({ [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(PUBLIC) })
    await run(['kits', 'show', `https://app.orcapods.ai/kits/${PUBLIC_ID}`])
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(stdout()).toBe('agent-1\tagent\tsupport\nskill-1\tskill\ttriage\n')
  })

  it('names a withdrawn kit', async () => {
    stubFetch({
      [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(
        { error: { message: 'Support desk was withdrawn by its author', code: 'kit_withdrawn' } },
        { status: 410 },
      ),
    })
    await expect(run(['kits', 'show', PUBLIC_ID])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
      message: 'Support desk was withdrawn by its author',
    })
  })
})

describe('kits copy', () => {
  it('copies every asset under its own name, then lists the credentials to add', async () => {
    const calls = stubFetch({
      [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(PUBLIC),
      [`POST /api/kits/${PUBLIC_ID}/copy`]: jsonResponse({
        object: 'kit.copy',
        public_id: PUBLIC_ID,
        version: 1,
        created: [
          { key: 'skill-1', kind: 'skill', id: 'skill_9', name: 'triage' },
          { key: 'agent-1', kind: 'agent', id: 'agent_9', name: 'support' },
        ],
        credentials: PUBLIC.credentials,
      }),
    })
    await run(['kits', 'copy', PUBLIC_ID, '--yes'])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({
      assets: [
        { key: 'agent-1', name: 'support' },
        { key: 'skill-1', name: 'triage' },
      ],
    })
    expect(stdout()).toBe('skill\tskill_9\ttriage\nagent\tagent_9\tsupport\n')
    expect(stderr()).toContain('mcp server docs (https://mcp.example.com), used by support')
  })

  it('renames with --name and leaves out with --skip', async () => {
    const calls = stubFetch({
      [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(PUBLIC),
      [`POST /api/kits/${PUBLIC_ID}/copy`]: jsonResponse({ object: 'kit.copy', created: [], credentials: [] }),
    })
    await run(['kits', 'copy', PUBLIC_ID, '--name', 'agent-1=helpdesk', '--skip', 'skill-1', '--yes'])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ assets: [{ key: 'agent-1', name: 'helpdesk' }] })
  })

  it('reports a taken name and that nothing was copied', async () => {
    stubFetch({
      [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(PUBLIC),
      [`POST /api/kits/${PUBLIC_ID}/copy`]: jsonResponse(
        { error: { message: 'Name taken: support', code: 'name_taken' } },
        { status: 409 },
      ),
    })
    await expect(run(['kits', 'copy', PUBLIC_ID, '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: 'Name taken: support',
      detail: [expect.stringContaining('Nothing was copied')],
    })
  })

  it('refuses a key the kit does not have, or renaming and skipping one asset', async () => {
    stubFetch({ [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(PUBLIC) })
    await expect(run(['kits', 'copy', PUBLIC_ID, '--skip', 'template-1', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    await expect(
      run(['kits', 'copy', PUBLIC_ID, '--skip', 'agent-1', '--name', 'agent-1=x', '--yes']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('shows the plan with --dry-run and copies nothing', async () => {
    const calls = stubFetch({ [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(PUBLIC) })
    await run(['kits', 'copy', PUBLIC_ID, '--dry-run'])
    expect(calls).toHaveLength(1)
    expect(stdout()).toBe('agent-1\tsupport\nskill-1\ttriage\n')
  })

  it('refuses to copy without --yes when there is nobody to ask', async () => {
    stubFetch({ [`GET /api/public/kits/${PUBLIC_ID}`]: jsonResponse(PUBLIC) })
    await expect(run(['kits', 'copy', PUBLIC_ID])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })
})
