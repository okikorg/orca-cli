import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseKitLink, registerKits } from '../../src/commands/kits.js'
import { saveConfig } from '../../src/lib/config.js'
import { ExitCode } from '../../src/lib/errors.js'
import { jsonResponse, stubFetch, type RecordedCall } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

// The conductor answers the beacon and the pin endpoints with a bare 204,
// which Response refuses to build with a body, so they get their own helper.
function noContent() {
  return () => new Response(null, { status: 204 })
}

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'
const ID = 'kit-utRCllawsrI2cqKdT'
const LINK = `https://app.orcapods.ai/kits/${ID}`

let cleanup: () => Promise<void>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
  registerKits(program)
  await program.parseAsync(args, { from: 'user' })
}

// The kit row the share link resolves to: a pod kit carrying one skill and one
// agent, the shape of the seo-helper kit on app.orcapods.ai.
const KIT = { id: 'tpl-1', publicId: ID, slug: 'seo-helper', label: 'seo-helper', authorHandle: 'orca' }

const PLAN = {
  templateId: 'tpl-1',
  version: 3,
  assets: [
    { kind: 'skill', name: 'seo', digest: 'd1', status: 'new', collision: false, suggestedName: 'seo' },
    { kind: 'profile', name: 'writer', digest: 'd2', status: 'new', collision: false, suggestedName: 'writer' },
    { kind: 'pool', name: 'seo-pod', digest: 'd3', status: 'new', collision: false, suggestedName: 'seo-pod' },
  ],
}

const COPIED = { copied: true, skills: ['seo'], profiles: ['writer'], pool: 'seo-pod' }

function routes(over: Record<string, ReturnType<typeof jsonResponse> | Response> = {}) {
  return {
    [`GET /api/kits/${ID}`]: jsonResponse(KIT),
    [`POST /api/kits/${ID}/events`]: noContent(),
    'GET /api/templates/seo-helper/copy?id=tpl-1': jsonResponse(PLAN),
    'POST /api/templates/seo-helper/copy?id=tpl-1': jsonResponse(COPIED),
    'POST /api/pools/seo-pod/pin': noContent(),
    ...over,
  }
}

function bodyOf(calls: RecordedCall[], key: string): Record<string, unknown> {
  const call = calls.find((c) => `${c.method} ${c.path}` === key)
  if (!call?.body) throw new Error(`no body recorded for ${key}`)
  return JSON.parse(call.body) as Record<string, unknown>
}

function bodiesOf(calls: RecordedCall[], key: string): Record<string, unknown>[] {
  return calls
    .filter((c) => `${c.method} ${c.path}` === key && c.body)
    .map((c) => JSON.parse(c.body as string) as Record<string, unknown>)
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

function stderr(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((c) => c.map(String).join(' '))
    .join('\n')
}

describe('parseKitLink', () => {
  it('accepts the share URL, a bare id, and a trailing slash', () => {
    expect(parseKitLink(LINK)).toEqual({ publicId: ID })
    expect(parseKitLink(`  ${ID}  `)).toEqual({ publicId: ID })
    expect(parseKitLink(`${LINK}/`)).toEqual({ publicId: ID })
    expect(parseKitLink(`http://localhost:5173/kits/${ID}`)).toEqual({ publicId: ID })
  })

  it('carries the link campaign keys and never its source', () => {
    expect(
      parseKitLink(`${LINK}?utm_source=reddit&utm_medium=post&utm_campaign=launch`),
    ).toEqual({ publicId: ID, utm: { medium: 'post', campaign: 'launch' } })
  })

  it('rejects anything that is not a kit link', () => {
    for (const bad of ['', 'kit-short', 'https://app.orcapods.ai/kits/', 'ftp://x/kits/' + ID, 'nonsense']) {
      expect(() => parseKitLink(bad)).toThrowError()
    }
  })
})

describe('kit add', () => {
  it('resolves the link, reads the plan, copies, and pins, in that order', async () => {
    const calls = stubFetch(routes())
    await run(['kit', 'add', LINK, '--yes'])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/kits/${ID}`,
      `POST /api/kits/${ID}/events`,
      'GET /api/templates/seo-helper/copy?id=tpl-1',
      `POST /api/kits/${ID}/events`,
      'POST /api/templates/seo-helper/copy?id=tpl-1',
      'POST /api/pools/seo-pod/pin',
    ])
    expect(stdout()).toBe('skill\tseo\nagent\twriter\npod\tseo-pod\n')
  })

  it('pins the agents when the kit has no pod', async () => {
    const calls = stubFetch(
      routes({
        'POST /api/templates/seo-helper/copy?id=tpl-1': jsonResponse({ copied: true, profiles: ['writer'] }),
        'POST /api/profiles/writer/pin': noContent(),
      }),
    )
    await run(['kit', 'add', LINK, '--yes'])
    expect(calls.some((c) => c.path === '/api/profiles/writer/pin')).toBe(true)
  })

  it('leaves the pin alone with --no-pin', async () => {
    const calls = stubFetch(routes())
    await run(['kit', 'add', LINK, '--yes', '--no-pin'])
    expect(calls.some((c) => c.path.endsWith('/pin'))).toBe(false)
  })

  it('sends a view and a click marked as the CLI, sharing one visitor id', async () => {
    const calls = stubFetch(routes())
    await run(['kit', 'add', `${LINK}?utm_medium=post`, '--yes'])
    const events = bodiesOf(calls, `POST /api/kits/${ID}/events`)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'view', utm: { source: 'cli', medium: 'post' } })
    expect(events[1]).toMatchObject({ type: 'click', target: 'primary', utm: { source: 'cli' } })
    expect(events[0].visitorId).toBe(events[1].visitorId)
    expect(String(events[0].visitorId)).toMatch(/^[0-9A-Za-z_-]{8,64}$/)
  })

  it('adds the kit even when the beacon is unavailable', async () => {
    const calls = stubFetch(
      routes({ [`POST /api/kits/${ID}/events`]: jsonResponse({ error: 'nope' }, { status: 503 }) }),
    )
    await run(['kit', 'add', LINK, '--yes'])
    expect(calls.some((c) => `${c.method} ${c.path}` === 'POST /api/templates/seo-helper/copy?id=tpl-1')).toBe(true)
  })
})

describe('kit add name collisions', () => {
  // The whole no-collision contract: the server decides the new names, the CLI
  // sends them back unchanged. If this ever drifts, two workspaces adding the
  // same kit twice start overwriting each other's assets.
  it('sends the server-suggested names verbatim when assets collide', async () => {
    const collided = {
      ...PLAN,
      assets: [
        { kind: 'skill', name: 'seo', digest: 'd1', status: 'new', collision: true, suggestedName: 'seo-copy' },
        { kind: 'profile', name: 'writer', digest: 'd2', status: 'new', collision: true, suggestedName: 'writer-copy-2' },
        { kind: 'pool', name: 'seo-pod', digest: 'd3', status: 'unchanged', installedAs: 'seo-pod', collision: true, suggestedName: 'seo-pod-copy' },
      ],
    }
    const calls = stubFetch(
      routes({ 'GET /api/templates/seo-helper/copy?id=tpl-1': jsonResponse(collided) }),
    )
    await run(['kit', 'add', LINK, '--yes'])
    expect(bodyOf(calls, 'POST /api/templates/seo-helper/copy?id=tpl-1')).toEqual({
      assets: [
        { kind: 'skill', name: 'seo', targetName: 'seo-copy' },
        { kind: 'profile', name: 'writer', targetName: 'writer-copy-2' },
        { kind: 'pool', name: 'seo-pod', targetName: 'seo-pod-copy' },
      ],
    })
  })

  it('replaces only the overridden name with --name', async () => {
    const calls = stubFetch(routes())
    await run(['kit', 'add', LINK, '--yes', '--name', 'profile:writer=my-writer'])
    expect(bodyOf(calls, 'POST /api/templates/seo-helper/copy?id=tpl-1')).toEqual({
      assets: [
        { kind: 'skill', name: 'seo', targetName: 'seo' },
        { kind: 'profile', name: 'writer', targetName: 'my-writer' },
        { kind: 'pool', name: 'seo-pod', targetName: 'seo-pod' },
      ],
    })
  })

  it('leaves an asset out with --skip', async () => {
    const calls = stubFetch(routes())
    await run(['kit', 'add', LINK, '--yes', '--skip', 'skill:seo'])
    expect(bodyOf(calls, 'POST /api/templates/seo-helper/copy?id=tpl-1')).toEqual({
      assets: [
        { kind: 'profile', name: 'writer', targetName: 'writer' },
        { kind: 'pool', name: 'seo-pod', targetName: 'seo-pod' },
      ],
    })
  })

  it('refuses two selected assets of one kind under the same name', async () => {
    const twoSkills = {
      ...PLAN,
      assets: [
        { kind: 'skill', name: 'seo', digest: 'd1', status: 'new', collision: false, suggestedName: 'seo' },
        { kind: 'skill', name: 'research', digest: 'd2', status: 'new', collision: false, suggestedName: 'research' },
      ],
    }
    stubFetch(routes({ 'GET /api/templates/seo-helper/copy?id=tpl-1': jsonResponse(twoSkills) }))
    await expect(
      run(['kit', 'add', LINK, '--yes', '--name', 'skill:research=seo']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('refuses a flag that names an asset the kit does not have', async () => {
    stubFetch(routes())
    await expect(run(['kit', 'add', LINK, '--yes', '--skip', 'skill:ghost'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    await expect(run(['kit', 'add', LINK, '--yes', '--skip', 'widget:seo'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('refuses an add with every asset skipped', async () => {
    stubFetch(routes())
    await expect(
      run(['kit', 'add', LINK, '--yes', '--skip', 'skill:seo', '--skip', 'profile:writer', '--skip', 'pool:seo-pod']),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('reports a name taken between the plan and the copy, without overwriting', async () => {
    stubFetch(
      routes({
        'POST /api/templates/seo-helper/copy?id=tpl-1': jsonResponse(
          { error: 'copy_conflicts', conflicts: [{ kind: 'profile', targetName: 'writer' }] },
          { status: 409 },
        ),
      }),
    )
    await expect(run(['kit', 'add', LINK, '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
      message: 'name taken: profile "writer"',
    })
  })

  it('notes what lost a race but still reports the add', async () => {
    stubFetch(
      routes({
        'POST /api/templates/seo-helper/copy?id=tpl-1': jsonResponse({
          ...COPIED,
          skipped: [{ kind: 'skill', name: 'seo', targetName: 'seo', reason: 'race_conflict' }],
        }),
      }),
    )
    await run(['kit', 'add', LINK, '--yes'])
    expect(stderr()).toContain('skill "seo"')
  })

  it('fails when nothing landed at all', async () => {
    stubFetch(
      routes({
        'POST /api/templates/seo-helper/copy?id=tpl-1': jsonResponse({
          copied: false,
          skipped: [{ kind: 'pool', name: 'seo-pod', targetName: 'seo-pod', reason: 'race_conflict' }],
        }),
      }),
    )
    await expect(run(['kit', 'add', LINK, '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Failure,
    })
  })
})

describe('kit add dead ends', () => {
  it('names a link nobody published', async () => {
    stubFetch({ [`GET /api/kits/${ID}`]: jsonResponse({ error: 'template not found' }, { status: 404 }) })
    await expect(run(['kit', 'add', LINK, '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    })
  })

  it('names a kit its author withdrew', async () => {
    stubFetch({
      [`GET /api/kits/${ID}`]: jsonResponse({ error: 'template was deleted by its owner' }, { status: 410 }),
    })
    await expect(run(['kit', 'add', LINK, '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
      message: `kit ${ID} was withdrawn by its author`,
    })
  })

  it('offers the link instead of an install for a kit that links out', async () => {
    const calls = stubFetch({
      [`GET /api/kits/${ID}`]: jsonResponse({
        ...KIT,
        action: { label: 'Get started', url: 'https://docs.orcapods.ai/start-here' },
      }),
    })
    await run(['kit', 'add', LINK, '--yes'])
    expect(stdout()).toContain('https://docs.orcapods.ai/start-here')
    expect(calls).toHaveLength(1)
  })

  it('refuses to add without --yes when there is nobody to ask', async () => {
    stubFetch(routes())
    await expect(run(['kit', 'add', LINK])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('rejects a bad link before any network call', async () => {
    const calls = stubFetch(routes())
    await expect(run(['kit', 'add', 'https://app.orcapods.ai/kits/nope', '--yes'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('kit add --dry-run', () => {
  it('shows the plan and copies nothing', async () => {
    const calls = stubFetch(routes())
    await run(['kit', 'add', LINK, '--dry-run'])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/kits/${ID}`,
      `POST /api/kits/${ID}/events`,
      'GET /api/templates/seo-helper/copy?id=tpl-1',
    ])
    expect(stdout()).toBe('skill\tseo\tnew\tseo\nprofile\twriter\tnew\twriter\npool\tseo-pod\tnew\tseo-pod\n')
  })

  it('emits the resolved plan with --json', async () => {
    stubFetch(routes())
    await run(['--json', 'kit', 'add', LINK, '--dry-run', '--skip', 'skill:seo'])
    const out = JSON.parse(stdout()) as { assets: { name: string; selected: boolean; targetName: string }[] }
    expect(out.assets.map((a) => [a.name, a.selected, a.targetName])).toEqual([
      ['seo', false, 'seo'],
      ['writer', true, 'writer'],
      ['seo-pod', true, 'seo-pod'],
    ])
  })
})

describe('kit add --json', () => {
  it('emits the copy outcome and whether it was pinned', async () => {
    stubFetch(routes())
    await run(['--json', 'kit', 'add', LINK, '--yes'])
    expect(JSON.parse(stdout())).toEqual({ ...COPIED, pinned: true })
  })
})
