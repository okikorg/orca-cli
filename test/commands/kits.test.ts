import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { parseKitLink, registerKits } from '../../src/commands/kits.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { API, commandHarness } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

// The y/N question, answered by each test that reaches it.
const confirm = vi.hoisted(() => vi.fn<(question: string) => Promise<boolean>>(async () => false))
vi.mock('../../src/commands/prompts.js', () => ({ confirm }))

const PUBLIC_ID = 'kit-AbCdEfGhIjKlMnOpQ'
const REVIEW_ROUTE = `GET /api/public/kits/${PUBLIC_ID}/review`
const COPY_ROUTE = `POST /api/kits/${PUBLIC_ID}/copy`

const CREDENTIALS = [
  { kind: 'mcp_server', name: 'docs', server_url: 'https://mcp.example.com', used_by: 'support', asset: 'agent-1' },
  { kind: 'environment_variable', name: 'GITHUB_TOKEN', used_by: 'triage-env', asset: 'template-1' },
]

// A review as GET /api/public/kits/{public_id}/review returns it, with one of
// every part the server shows.
const REVIEW = {
  object: 'kit.review',
  public_id: PUBLIC_ID,
  version: 3,
  published_at: 1_783_245_600,
  publisher: { orca: true },
  name: 'Support desk',
  description: 'Answers tickets',
  summary: {
    runs_code: [
      'support (agent-1) starts the MCP server tickets in its sandbox: npx tickets-mcp --stdio',
      'triage (skill-1) carries files an agent can run: run.sh',
      'triage-env (template-1) runs 1 setup command as root in your sandbox',
    ],
    reaches: ['https://mcp.example.com (MCP server docs, used by support (agent-1))', 'pypi.org (triage-env (template-1))'],
    spends: ['Models: openai/gpt-5', 'Web search: support (agent-1)', 'Every run is paid from your organization\'s credit'],
  },
  agents: [
    {
      key: 'agent-1',
      name: 'support',
      model: 'openai/gpt-5',
      reasoning_effort: 'low',
      service_tier: 'auto',
      team: { enabled: false, max_concurrent_subagents: null },
      instructions: 'Answer every ticket.\nNever close one.',
      tools: [
        { type: 'web_search', mode: 'live', context_size: 'medium', allowed_domains: null },
        { type: 'function', name: 'lookup', description: 'Find an order' },
        {
          type: 'mcp',
          server_label: 'docs',
          allowed_tools: ['search'],
          required: false,
          request_metadata_keys: [],
          transport: { type: 'http', server_url: 'https://mcp.example.com', header_names: ['X-Team'] },
        },
        {
          type: 'mcp',
          server_label: 'tickets',
          allowed_tools: null,
          required: false,
          request_metadata_keys: [],
          transport: { type: 'stdio', command: 'npx', args: ['tickets-mcp', '--stdio'], cwd: '/workspace', env_var_names: ['TICKETS_URL'] },
        },
      ],
    },
  ],
  skills: [
    {
      key: 'skill-1',
      name: 'triage',
      description: 'Sort tickets',
      files: [
        { path: 'SKILL.md', size_bytes: 40, sha256: 'a'.repeat(64), content: '---\nname: triage\n---\nSort by urgency.', hash_only: null },
        { path: 'logo.png', size_bytes: 512, sha256: 'b'.repeat(64), content: null, hash_only: 'binary' },
        { path: 'run.sh', size_bytes: 18, sha256: 'c'.repeat(64), content: 'echo sorting\nexit 0', hash_only: null },
      ],
    },
  ],
  templates: [
    {
      key: 'template-1',
      name: 'triage-env',
      network: { access: 'restricted', allowed_domains: ['pypi.org'] },
      packages: { python: ['requests'] },
      setup_commands: [{ command: 'pip install -r requirements.txt', cwd: null }],
      capability_directories: [],
      files: [{ path: 'requirements.txt', size_bytes: 9, sha256: 'd'.repeat(64), content: 'requests\n', hash_only: null }],
      skills: [{ type: 'kit_skill', key: 'skill-1' }],
      plugins: [],
    },
  ],
  credentials: CREDENTIALS,
}

const COPIED = {
  object: 'kit.copy',
  public_id: PUBLIC_ID,
  version: 3,
  created: [
    { key: 'skill-1', kind: 'skill', id: 'skill_9', name: 'triage' },
    { key: 'agent-1', kind: 'agent', id: 'agent_9', name: 'support' },
    { key: 'template-1', kind: 'template', id: 'envtmpl_9', name: 'triage-env' },
  ],
  credentials: CREDENTIALS,
}

const { run, stdout, stderr } = commandHarness(registerKits)

// asTerminal runs fn with stdin and stdout as a terminal, as a person's shell.
async function asTerminal(fn: () => Promise<void>): Promise<void> {
  const [stdin, stdoutTty] = [process.stdin.isTTY, process.stdout.isTTY]
  process.stdin.isTTY = true
  process.stdout.isTTY = true
  try {
    await fn()
  } finally {
    process.stdin.isTTY = stdin
    process.stdout.isTTY = stdoutTty
  }
}

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

describe('kits', () => {
  it('only shows and copies: Orca publishes kits', () => {
    const program = new Command()
    registerKits(program)
    const kits = program.commands.find((c) => c.name() === 'kits')
    expect(kits?.commands.map((c) => c.name())).toEqual(['show', 'copy'])
  })

  it('has no make, edit, publish, withdraw or list', async () => {
    const calls = stubFetch({})
    for (const gone of ['make', 'edit', 'publish', 'withdraw', 'list']) {
      await expect(run(['kits', gone, 'kit_1'])).rejects.toMatchObject({ code: 'commander.unknownCommand' })
    }
    expect(calls).toHaveLength(0)
  })
})

describe('kits show', () => {
  it('prints the review without a credential: publisher, version, summaries, then every asset in full', async () => {
    await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: API } } })
    const calls = stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW) })
    await run(['kits', 'show', `https://app.orcapods.ai/kits/${PUBLIC_ID}`])
    expect(calls[0].headers.Authorization).toBeUndefined()
    const out = stdout()
    expect(out.split('\n').slice(0, 4)).toEqual([
      'Support desk',
      '  by Orca',
      `  ${PUBLIC_ID} · version 3 · published 2026-07-05 10:00`,
      '  | Answers tickets',
    ])
    // The summaries come before any asset, each line as the server wrote it.
    for (const line of [...REVIEW.summary.runs_code, ...REVIEW.summary.reaches, ...REVIEW.summary.spends]) {
      expect(out).toContain(`  - ${line}\n`)
    }
    expect(out.indexOf('Spends:')).toBeLessThan(out.indexOf('Agent agent-1: support'))
    expect(out).toContain('  Model: openai/gpt-5\n  Reasoning effort: low\n  Service tier: auto\n  Team: no\n')
    expect(out).toContain('  Instructions:\n    | Answer every ticket.\n    | Never close one.\n')
    expect(out).toContain('    - web search, mode live, context medium, domains any\n')
    expect(out).toContain('    - function lookup: Find an order\n')
    expect(out).toContain('    - MCP docs over HTTP: https://mcp.example.com, allowed tools search, header names X-Team\n')
    expect(out).toContain(
      '    - MCP tickets over stdio: npx tickets-mcp --stdio, in /workspace, allowed tools all, environment variable names TICKETS_URL\n',
    )
    // Skill files: SKILL.md and other text in full, a binary file by hash only.
    expect(out).toContain(`    SKILL.md  40 bytes  sha256 ${'a'.repeat(64)}\n      | ---\n      | name: triage\n`)
    expect(out).toContain(`    logo.png  512 bytes  sha256 ${'b'.repeat(64)}  (binary, listed by hash)\n`)
    expect(out).toContain('      | echo sorting\n      | exit 0\n')
    // The template: network, packages, every setup command, files, skills.
    expect(out).toContain('  Network: restricted to pypi.org\n')
    expect(out).toContain('  Packages, system: none\n  Packages, python: requests\n  Packages, npm: none\n')
    expect(out).toContain('  Setup commands, in order:\n    1. in the workspace\n      | pip install -r requirements.txt\n')
    expect(out).toContain('      | requests\n')
    expect(out).toContain('  Skills:\n    - the kit\'s skill-1\n  Plugins:\n    none\n')
    expect(out).toContain('  - MCP server credential docs (https://mcp.example.com), used by support: add it to a vault\n')
    expect(out).toContain('  - Environment variable GITHUB_TOKEN, used by triage-env: set it on the template once copied\n')
  })

  it('prints no by line without publisher.orca', async () => {
    stubFetch({ [REVIEW_ROUTE]: jsonResponse({ ...REVIEW, publisher: {} }) })
    await run(['kits', 'show', PUBLIC_ID])
    expect(stdout()).toContain('Support desk')
    expect(stdout()).not.toContain('by Orca')
  })

  it('prints the review route\'s body with --json', async () => {
    stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW) })
    await run(['--json', 'kits', 'show', PUBLIC_ID])
    expect(JSON.parse(stdout())).toEqual(REVIEW)
  })

  it('names a withdrawn kit, and an unknown one', async () => {
    stubFetch({
      [REVIEW_ROUTE]: jsonResponse({ error: { message: 'This kit was withdrawn by Orca', code: 'kit_withdrawn' } }, { status: 410 }),
    })
    await expect(run(['kits', 'show', PUBLIC_ID])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
      message: 'This kit was withdrawn by Orca',
    })
    stubFetch({ [REVIEW_ROUTE]: jsonResponse({ error: { message: 'Not found', code: 'not_found' } }, { status: 404 }) })
    await expect(run(['kits', 'show', PUBLIC_ID])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
      message: `no kit at ${PUBLIC_ID}`,
    })
  })
})

describe('kits copy', () => {
  it('prints the review, then copies the version it printed, and lists the credentials to add', async () => {
    const calls = stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW), [COPY_ROUTE]: jsonResponse(COPIED) })
    await run(['kits', 'copy', PUBLIC_ID, '--yes'])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({
      version: 3,
      assets: [
        { key: 'agent-1', name: 'support' },
        { key: 'skill-1', name: 'triage' },
        { key: 'template-1', name: 'triage-env' },
      ],
    })
    // The review is on stderr, so stdout is only the copy's result.
    expect(stderr()).toContain(`  ${PUBLIC_ID} · version 3`)
    expect(stderr()).toContain('    | Answer every ticket.')
    expect(stdout()).toBe('skill\tskill_9\ttriage\nagent\tagent_9\tsupport\ntemplate\tenvtmpl_9\ttriage-env\n')
    // Each credential says where it is added.
    expect(stderr()).toContain('MCP server credential docs (https://mcp.example.com), used by support: add it to a vault')
    expect(stderr()).toContain('Environment variable GITHUB_TOKEN, used by triage-env: set it on template triage-env (envtmpl_9)')
  })

  it('asks y/N at a terminal and copies only after a yes', async () => {
    const calls = stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW), [COPY_ROUTE]: jsonResponse(COPIED) })
    await asTerminal(async () => {
      confirm.mockResolvedValueOnce(false)
      await run(['kits', 'copy', PUBLIC_ID])
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
      expect(stderr()).toContain('Aborted.')
      confirm.mockResolvedValueOnce(true)
      await run(['kits', 'copy', PUBLIC_ID])
    })
    expect(confirm).toHaveBeenLastCalledWith('Copy "Support desk" version 3 into this organization?')
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0].body ?? '{}')).toMatchObject({ version: 3 })
  })

  it('on kit_changed prints the new review, copies nothing, and exits non-zero', async () => {
    let reviews = 0
    const changed = { ...REVIEW, version: 4, description: 'Answers and closes tickets' }
    const calls = stubFetch({
      [REVIEW_ROUTE]: (call) => jsonResponse(reviews++ === 0 ? REVIEW : changed)(call),
      [COPY_ROUTE]: jsonResponse(
        {
          error: {
            message: 'This kit has a newer version (4). Review it again before copying.',
            code: 'kit_changed',
            current_version: 4,
          },
        },
        { status: 409 },
      ),
    })
    await expect(run(['kits', 'copy', PUBLIC_ID, '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: 'nothing was copied',
      detail: ['Read version 4 above, and run the copy again to copy it.'],
    })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([REVIEW_ROUTE, COPY_ROUTE, REVIEW_ROUTE])
    const after = stderr().split('This kit changed while you were reading. Here is the new version.')[1] ?? ''
    expect(after).toContain(`  ${PUBLIC_ID} · version 4`)
    expect(after).toContain('  | Answers and closes tickets')
  })

  it('renames with --name and leaves out with --skip', async () => {
    const calls = stubFetch({
      [REVIEW_ROUTE]: jsonResponse(REVIEW),
      [COPY_ROUTE]: jsonResponse({ ...COPIED, created: [], credentials: [] }),
    })
    await run(['kits', 'copy', PUBLIC_ID, '--name', 'agent-1=helpdesk', '--skip', 'skill-1', '--skip', 'template-1', '--yes'])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ version: 3, assets: [{ key: 'agent-1', name: 'helpdesk' }] })
  })

  it('reports a taken name and that nothing was copied', async () => {
    stubFetch({
      [REVIEW_ROUTE]: jsonResponse(REVIEW),
      [COPY_ROUTE]: jsonResponse({ error: { message: 'Name taken: support', code: 'name_taken' } }, { status: 409 }),
    })
    await expect(run(['kits', 'copy', PUBLIC_ID, '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: 'Name taken: support',
      detail: [expect.stringContaining('Nothing was copied')],
    })
  })

  it('reports another conflict as itself, not as a taken name', async () => {
    stubFetch({
      [REVIEW_ROUTE]: jsonResponse(REVIEW),
      [COPY_ROUTE]: jsonResponse(
        { error: { message: 'Idempotency-Key was used for a different request', code: 'conflict' } },
        { status: 409 },
      ),
    })
    const failure = run(['kits', 'copy', PUBLIC_ID, '--yes'])
    await expect(failure).rejects.toMatchObject({ exitCode: ExitCode.Failure })
    await expect(failure).rejects.not.toMatchObject({ detail: [expect.stringContaining('Choose another name')] })
  })

  it('refuses a key the kit does not have, or renaming and skipping one asset', async () => {
    stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW) })
    await expect(run(['kits', 'copy', PUBLIC_ID, '--skip', 'template-9', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    await expect(
      run(['kits', 'copy', PUBLIC_ID, '--skip', 'agent-1', '--name', 'agent-1=x', '--yes']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('prints the review and the plan with --dry-run, and copies nothing', async () => {
    const calls = stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW) })
    await run(['kits', 'copy', PUBLIC_ID, '--dry-run'])
    expect(calls).toHaveLength(1)
    expect(stderr()).toContain('Runs code:')
    expect(stdout()).toBe('agent-1\tsupport\nskill-1\ttriage\ntemplate-1\ttriage-env\n')
  })

  it('names the version in the --dry-run plan with --json', async () => {
    stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW) })
    await run(['--json', 'kits', 'copy', PUBLIC_ID, '--dry-run'])
    expect(JSON.parse(stdout())).toMatchObject({ public_id: PUBLIC_ID, version: 3 })
  })

  it('exits 2 without --yes when there is no terminal to ask in', async () => {
    confirm.mockClear()
    const calls = stubFetch({ [REVIEW_ROUTE]: jsonResponse(REVIEW) })
    await expect(run(['kits', 'copy', PUBLIC_ID])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(confirm).not.toHaveBeenCalled()
  })
})
