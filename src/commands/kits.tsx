import { readFile } from 'node:fs/promises'

import type { Command } from 'commander'

import { resolveAgentId } from '../lib/agents.js'
import { ApiClient, ApiError, extractErrorBody, mapApiError } from '../lib/api.js'
import { requireApiUrl, resolveContext } from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type {
  Kit,
  KitCopyAsset,
  KitCopyResult,
  KitCredential,
  KitInput,
  KitSelection,
  PublicKit,
  PublicKitAsset,
} from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import { apiContext, globalFlags, withApi, type ApiContext } from './shared.js'

// A kit's public id: kit- plus 17 letters or digits, minted on its first
// publish and never changed. Checked here so a mistyped link fails before a
// round trip.
const KIT_ID = /^kit-[0-9A-Za-z]{17}$/

// parseKitLink turns what the user pasted into a public id. It accepts the
// share link (https://app.orcapods.ai/kits/kit-...), any origin serving that
// path, and a bare public id.
export function parseKitLink(input: string): string {
  const raw = input.trim()
  if (KIT_ID.test(raw)) return raw
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw kitLinkError(input)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw kitLinkError(input)
  const segments = url.pathname.split('/').filter(Boolean)
  const publicId = segments.at(-1) ?? ''
  if (!KIT_ID.test(publicId)) throw kitLinkError(input)
  return publicId
}

function kitLinkError(input: string): CliError {
  return new CliError(`not a kit link: ${JSON.stringify(input)}`, ExitCode.Usage, [
    'Expected https://app.orcapods.ai/kits/kit-... or a bare kit id.',
  ])
}

// kitAssets lists everything a published kit holds, each with the key the
// copy names it by and the name it is copied under by default.
function kitAssets(kit: PublicKit): (PublicKitAsset & { kind: string })[] {
  return [
    ...kit.contents.agents.map((a) => ({ ...a, kind: 'agent' })),
    ...kit.contents.skills.map((s) => ({ ...s, kind: 'skill' })),
    ...kit.contents.templates.map((t) => ({ ...t, kind: 'template' })),
  ]
}

// copyPlan applies --name and --skip to a kit's assets and returns the copy
// request's assets. Every asset is copied under its own name unless renamed
// or skipped; the server answers 409 name_taken for a name already in use
// and copies nothing, so a collision is fixed with --name and a rerun.
function copyPlan(kit: PublicKit, renames: Map<string, string>, skips: Set<string>): KitCopyAsset[] {
  const assets = kitAssets(kit)
  const known = new Set(assets.map((a) => a.key))
  for (const key of [...renames.keys(), ...skips]) {
    if (!known.has(key)) {
      throw new CliError(`this kit has no asset "${key}"`, ExitCode.Usage, [
        `Assets: ${[...known].join(', ') || 'none'}`,
      ])
    }
  }
  const chosen = assets
    .filter((a) => !skips.has(a.key))
    .map((a) => ({ key: a.key, name: (renames.get(a.key) ?? a.name).trim() }))
  if (chosen.length === 0) {
    throw new CliError('every asset in this kit was skipped, so there is nothing to copy', ExitCode.Usage)
  }
  for (const asset of chosen) {
    if (!asset.name) throw new CliError(`${asset.key} needs a name`, ExitCode.Usage)
  }
  return chosen
}

function parseRename(spec: string): [string, string] {
  const eq = spec.indexOf('=')
  const key = eq < 0 ? '' : spec.slice(0, eq).trim()
  const name = eq < 0 ? '' : spec.slice(eq + 1).trim()
  if (!key || !name) {
    throw new CliError(`--name expects <key>=<new name>, got ${JSON.stringify(spec)}`, ExitCode.Usage, [
      'Keys are listed by: orca kits show <link>',
    ])
  }
  return [key, name]
}

function credentialLine(c: KitCredential): string {
  const extra = typeof c.server_url === 'string' ? ` (${c.server_url})` : ''
  return `${c.kind.replace(/_/g, ' ')} ${c.name}${extra}, used by ${c.used_by}`
}

// shareLink is a published kit's public page on the dashboard.
function shareLink(dashboardUrl: string | undefined, publicId: string): string | null {
  return dashboardUrl ? `${dashboardUrl.replace(/\/+$/, '')}/kits/${publicId}` : null
}

// fetchPublicKit reads a kit's public page. It needs no credential, so it
// works before login against any server URL.
async function fetchPublicKit(cmd: Command, publicId: string): Promise<PublicKit> {
  const ctx = await resolveContext(globalFlags(cmd))
  const apiUrl = requireApiUrl(ctx)
  const client = new ApiClient({ apiUrl, apiKey: ctx.apiKey ?? '', contextName: ctx.name })
  try {
    return await client.publicKit(publicId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new CliError(`no kit at ${publicId}`, ExitCode.NotFound, [
        'Check the link: it should look like https://app.orcapods.ai/kits/kit-...',
      ])
    }
    throw mapApiError(err, { contextName: ctx.name, apiUrl })
  }
}

type SelectionFlags = { agent: string[]; skill: string[]; template: string[] }

const repeatable = (value: string, previous: string[]) => [...previous, value]

function addKitFields(cmd: Command, nameRequired: boolean): Command {
  return (nameRequired ? cmd.requiredOption('--name <name>', 'kit name') : cmd.option('--name <name>', 'kit name'))
    .option('--description <text>', 'one-line description')
    .option('--readme <path>', 'a markdown file for the kit page')
    .option('--agent <agent>', 'include an agent, by id or name (repeatable)', repeatable, [] as string[])
    .option('--skill <id>', 'include a skill (repeatable)', repeatable, [] as string[])
    .option('--template <id>', 'include an environment template (repeatable)', repeatable, [] as string[])
}

async function selectionFrom(api: ApiContext, flags: SelectionFlags): Promise<KitSelection> {
  const agents: string[] = []
  for (const ref of flags.agent) agents.push(await withApi(api, async (c) => resolveAgentId(await c.v1(), ref)))
  return { agents, skills: flags.skill, templates: flags.template }
}

async function renderKits(kits: Kit[]): Promise<void> {
  const { Table } = await import('../ui/Table.js')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Table
      title="Kits"
      meta={`${kits.length} total`}
      headers
      hint="orca kits publish <kit id> · orca kits show <public id>"
      columns={[
        { header: 'name', get: (k: Kit) => k.name, color: () => theme.accent, bold: true },
        { header: 'status', get: (k: Kit) => k.status },
        { header: 'version', get: (k: Kit) => (k.latest_version == null ? '-' : String(k.latest_version)) },
        { header: 'public id', get: (k: Kit) => k.public_id ?? '-' },
        { header: 'id', get: (k: Kit) => k.id, color: () => theme.subtle },
      ]}
      rows={kits}
    />,
  )
}

async function renderPublicKit(kit: PublicKit): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { Table } = await import('../ui/Table.js')
  const { Box, Text } = await import('ink')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title={kit.name} subtitle={`${kit.public_id} · version ${kit.version}`}>
      {kit.description ? <Field label="about" value={kit.description} /> : null}
      <Field label="published" value={formatTime(kit.published_at)} />
      <Box marginTop={1} flexDirection="column">
        <Table
          headers
          columns={[
            { header: 'key', get: (a: PublicKitAsset & { kind: string }) => a.key, color: () => theme.subtle },
            { header: 'kind', get: (a: PublicKitAsset & { kind: string }) => a.kind },
            { header: 'name', get: (a: PublicKitAsset & { kind: string }) => a.name, color: () => theme.accent, bold: true },
          ]}
          rows={kitAssets(kit)}
          hint={`orca kits copy ${kit.public_id}`}
        />
      </Box>
      {kit.credentials.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.subtle}>credentials to add after copying</Text>
          {kit.credentials.map((c, i) => (
            <Text key={i} color={theme.muted}>{`  ${credentialLine(c)}`}</Text>
          ))}
        </Box>
      ) : null}
    </Panel>,
  )
}

export function registerKits(program: Command): void {
  const kits = program
    .command('kits')
    .alias('kit')
    .description('bundle agents, skills, and templates into a shareable kit, and copy kits in')

  kits
    .command('list')
    .description('list this organization\'s kits, newest first')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const list = await withApi(api, (c) => c.listKits())
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(list)
        return
      }
      if (list.length === 0) {
        console.error(hintText('No kits yet.'))
        console.error(hintText('  make one: orca kits make --name <name> --agent <agent>'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(list.map((k) => [k.id, k.name, k.status, k.latest_version ?? '-', k.public_id ?? '-']))
        return
      }
      await renderKits(list)
    })

  addKitFields(kits.command('make').description('make a kit from agents, skills, and templates'), true).action(
    async (opts: SelectionFlags & { name: string; description?: string; readme?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const input: KitInput = {
        name: opts.name,
        selection: await selectionFrom(api, opts),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.readme !== undefined ? { readme: await readReadme(opts.readme) } : {}),
      }
      const kit = await withApi(api, (c) => c.createKit(input))
      if (outputMode(flags) === 'json') printJson(kit)
      else {
        console.log(`${accentVerb('Made')} kit "${kit.name}" (${kit.id}).`)
        console.error(hintText(`Publish it: orca kits publish ${kit.id}`))
      }
    },
  )

  addKitFields(
    kits
      .command('edit <kit-id>')
      .description('change a kit; any --agent/--skill/--template replaces the whole selection'),
    false,
  ).action(
    async (
      id: string,
      opts: SelectionFlags & { name?: string; description?: string; readme?: string },
      cmd: Command,
    ) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const changesSelection = opts.agent.length + opts.skill.length + opts.template.length > 0
      const input: Partial<KitInput> = {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.readme !== undefined ? { readme: await readReadme(opts.readme) } : {}),
        ...(changesSelection ? { selection: await selectionFrom(api, opts) } : {}),
      }
      if (Object.keys(input).length === 0) {
        throw new CliError('nothing to change', ExitCode.Usage, [
          'Pass --name, --description, --readme, or a new selection.',
        ])
      }
      const kit = await withApi(api, (c) => c.updateKit(id, input))
      if (outputMode(flags) === 'json') printJson(kit)
      else {
        console.log(`${accentVerb('Updated')} kit "${kit.name}".`)
        if (kit.public_id) console.error(hintText(`The public page changes when you publish again: orca kits publish ${kit.id}`))
      }
    },
  )

  kits
    .command('publish <kit-id>')
    .description('publish the kit\'s current selection as its next version')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const kit = await withApi(api, (c) => c.publishKit(id))
      const link = kit.public_id ? shareLink(api.resolved.dashboardUrl, kit.public_id) : null
      if (outputMode(flags) === 'json') {
        printJson({ ...kit, link })
        return
      }
      console.log(`${accentVerb('Published')} kit "${kit.name}" version ${kit.latest_version} as ${kit.public_id}.`)
      if (link) console.log(`Share it: ${link}`)
    })

  kits
    .command('withdraw <kit-id>')
    .description('withdraw a published kit: its page and copies answer gone until published again')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const kit = await withApi(api, (c) => c.withdrawKit(id))
      if (outputMode(flags) === 'json') printJson(kit)
      else console.log(`${accentVerb('Withdrew')} kit "${kit.name}".`)
    })

  kits
    .command('show <link>')
    .description('show a published kit by its share link or public id (no login needed)')
    .action(async (link: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const kit = await fetchPublicKit(cmd, parseKitLink(link))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(kit)
        return
      }
      if (mode === 'plain') {
        printPlainRows(kitAssets(kit).map((a) => [a.key, a.kind, a.name]))
        return
      }
      await renderPublicKit(kit)
    })

  kits
    .command('copy <link>')
    .description('copy a published kit into this organization, by share link or public id')
    .option('--name <key=name>', 'copy one asset under a different name (repeatable)', repeatable, [] as string[])
    .option('--skip <key>', 'leave one asset out (repeatable)', repeatable, [] as string[])
    .option('--dry-run', 'show what would be copied and stop')
    .option('--yes', 'skip the confirmation prompt')
    .action(
      async (link: string, opts: { name: string[]; skip: string[]; dryRun?: boolean; yes?: boolean }, cmd: Command) => {
        const flags = globalFlags(cmd)
        const mode = outputMode(flags)
        const publicId = parseKitLink(link)
        const renames = new Map(opts.name.map(parseRename))
        const skips = new Set(opts.skip)
        for (const key of renames.keys()) {
          if (skips.has(key)) {
            throw new CliError(`--name and --skip both name "${key}"`, ExitCode.Usage, [
              'Rename it or leave it out, not both.',
            ])
          }
        }
        const api = await apiContext(cmd)
        const kit = await fetchPublicKit(cmd, publicId)
        const assets = copyPlan(kit, renames, skips)

        if (opts.dryRun) {
          if (mode === 'json') printJson({ public_id: publicId, assets })
          else printPlainRows(assets.map((a) => [a.key, a.name]))
          return
        }
        if (!opts.yes) {
          if (!interactive()) {
            throw new CliError('refusing to copy a kit without --yes in non-interactive mode', ExitCode.Usage)
          }
          for (const a of assets) console.error(hintText(`  ${a.key} as "${a.name}"`))
          if (!(await confirm(`Copy "${kit.name}" into this organization?`))) {
            console.error(hintText('Aborted.'))
            return
          }
        }

        const result = await withApi(api, async (c) => {
          try {
            return await c.copyKit(publicId, assets)
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              throw new CliError(extractErrorBody(err.body) || 'a name is taken', ExitCode.Failure, [
                'Nothing was copied. Choose another name with --name <key>=<name> and run it again.',
              ])
            }
            throw err
          }
        })
        reportCopy(result, mode)
      },
    )
}

async function readReadme(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`file not found: ${file}`, ExitCode.Usage)
    throw err
  }
}

function reportCopy(result: KitCopyResult, mode: 'json' | 'plain' | 'ink'): void {
  if (mode === 'json') {
    printJson(result)
    return
  }
  if (mode === 'plain') {
    printPlainRows(result.created.map((c) => [c.kind, c.id, c.name]))
  } else {
    console.log(`${accentVerb('Copied')} ${result.created.length} asset${result.created.length === 1 ? '' : 's'}:`)
    for (const c of result.created) console.log(`  ${c.kind} ${c.name} (${c.id})`)
  }
  if (result.credentials.length) {
    console.error(hintText('Add these credentials before the copied agents use them:'))
    for (const c of result.credentials) console.error(hintText(`  ${credentialLine(c)}`))
  }
}
