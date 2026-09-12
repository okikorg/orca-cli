import { randomUUID } from 'node:crypto'

import type { Command } from 'commander'

import { ApiError } from '../lib/api.js'
import type { ApiClient } from '../lib/api.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { glyphs, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import { apiContext, globalFlags, withApi, type ApiContext } from './shared.js'

// -- Wire shapes (kits, the copy plan, the page beacon) -----------------------
// Anchored on the conductor Templates handlers (agent-runtime/runtime/httpapi/
// kits.go, templates.go, templates_copyplan.go) and docs/openapi.yaml. A kit is
// a Template addressed by its immutable public id; adding one is the same three
// calls the dashboard's kit page makes (dashboard/src/pages/KitPage.tsx):
// resolve the id, read the copy plan, post the copy.

type KitAssetKind = 'skill' | 'profile' | 'pool' | 'automation' | 'poolFile'

const KIT_ASSET_KINDS: readonly KitAssetKind[] = [
  'skill',
  'profile',
  'pool',
  'automation',
  'poolFile',
]

type Kit = {
  id: string
  publicId: string
  slug: string
  label: string
  description?: string
  authorHandle?: string
  authorName?: string
  // Set only on a kit whose page offers a link instead of Add kit; copy and
  // save refuse it server-side (Template.LinksOut).
  action?: { label: string; url: string }
  deletedAt?: string | null
  version?: number
}

type KitPlanAsset = {
  kind: KitAssetKind
  name: string
  digest: string
  status: 'new' | 'changed' | 'unchanged'
  // The target name a previous add of this kit installed this asset under.
  installedAs?: string
  collision: boolean
  suggestedName: string
}

type KitCopyPlan = { templateId: string; version: number; assets: KitPlanAsset[] }

type KitCopySelection = { kind: KitAssetKind; name: string; targetName: string }

type KitCopySkipped = {
  kind: KitAssetKind
  name: string
  targetName: string
  reason: 'race_conflict'
}

type KitCopyResult = {
  copied: boolean
  reason?: 'already_exists'
  pool?: string
  profiles?: string[]
  skills?: string[]
  automation?: string
  automations?: string[]
  skipped?: KitCopySkipped[]
}

type KitUTM = {
  source?: string
  medium?: string
  campaign?: string
  content?: string
  term?: string
}

type KitEvent = {
  type: 'view' | 'click'
  target?: 'primary'
  visitorId?: string
  utm?: KitUTM
}

// A kit's public id: kit- plus 17 base62 characters, minted once and never
// changed. Same rule the conductor applies in validKitID, checked here so a
// mistyped link fails before a round trip.
const KIT_ID = /^kit-[0-9A-Za-z]{17}$/

// The utm_* keys the kit page forwards, minus source: for a terminal add the
// source IS the CLI, so it is set rather than carried over.
const UTM_KEYS = ['medium', 'campaign', 'content', 'term'] as const

export type ParsedKitLink = { publicId: string; utm?: KitUTM }

// parseKitLink turns what the user pasted into a public id plus whatever
// attribution rode along on the link. It accepts the share URL
// (https://app.orcapods.ai/kits/kit-...), any origin serving that path, and a
// bare kit id for someone who already knows it.
export function parseKitLink(input: string): ParsedKitLink {
  const raw = input.trim()
  if (!raw) throw kitLinkError(input)
  if (KIT_ID.test(raw)) return { publicId: raw }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw kitLinkError(input)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw kitLinkError(input)
  const segments = url.pathname.split('/').filter(Boolean)
  const publicId = segments[segments.length - 1] ?? ''
  if (!KIT_ID.test(publicId)) throw kitLinkError(input)

  const utm: KitUTM = {}
  let any = false
  for (const key of UTM_KEYS) {
    const value = (url.searchParams.get(`utm_${key}`) ?? '').trim()
    if (value) {
      utm[key] = value
      any = true
    }
  }
  return any ? { publicId, utm } : { publicId }
}

function kitLinkError(input: string): CliError {
  return new CliError(`not a kit link: ${JSON.stringify(input)}`, ExitCode.Usage, [
    'Expected https://app.orcapods.ai/kits/kit-... or a bare kit id.',
  ])
}

// -- Selecting what to add ----------------------------------------------------

export type KitSelectionRow = KitPlanAsset & { selected: boolean; targetName: string }

// resolvePlanRows applies --name and --skip to the server's plan.
//
// The DEFAULT target for every asset is the server's suggestedName, taken
// verbatim: that is where the whole no-collision behaviour lives
// (buildTemplateCopyPlan reads this workspace's previous add of the kit, then
// suggestTemplateAssetName walks name-copy, name-copy-2, ...). The CLI invents
// no names of its own, exactly as the dashboard's copy dialog does not
// (editableTemplateCopyPlan in dashboard/src/lib/templates.ts).
export function resolvePlanRows(
  plan: KitCopyPlan,
  overrides: Map<string, string>,
  skips: Set<string>,
): KitSelectionRow[] {
  const known = new Set(plan.assets.map((asset) => assetKey(asset.kind, asset.name)))
  for (const key of [...overrides.keys(), ...skips]) {
    if (!known.has(key)) {
      throw new CliError(`this kit has no asset "${key}"`, ExitCode.Usage, [
        `Assets: ${[...known].join(', ') || 'none'}`,
      ])
    }
  }
  return plan.assets.map((asset) => {
    const key = assetKey(asset.kind, asset.name)
    return {
      ...asset,
      selected: !skips.has(key),
      targetName: overrides.get(key) ?? asset.suggestedName,
    }
  })
}

// planSelections is the copy request body, with the two guards the copy dialog
// applies before it will enable its button. The server enforces both as well;
// checking here turns a 400 into a usage error that names the flag to fix.
export function planSelections(rows: KitSelectionRow[]): KitCopySelection[] {
  const selected = rows.filter((row) => row.selected)
  if (selected.length === 0) {
    throw new CliError('every asset in this kit was skipped, so there is nothing to add', ExitCode.Usage)
  }
  const seen = new Set<string>()
  for (const row of selected) {
    const target = row.targetName.trim()
    if (!target) {
      throw new CliError(`${row.kind} "${row.name}" needs a target name`, ExitCode.Usage)
    }
    const key = assetKey(row.kind, target)
    if (seen.has(key)) {
      throw new CliError(`target name "${target}" is used twice for ${row.kind}`, ExitCode.Usage)
    }
    seen.add(key)
  }
  return selected.map((row) => ({
    kind: row.kind,
    name: row.name,
    targetName: row.targetName.trim(),
  }))
}

function assetKey(kind: string, name: string): string {
  return `${kind}:${name}`
}

// parseAssetRef splits "<kind>:<name>" and checks the kind, so a typo is caught
// at the flag rather than as an "unknown template asset" from the server.
function parseAssetRef(spec: string, flag: string): string {
  const at = spec.indexOf(':')
  const kind = at < 0 ? '' : spec.slice(0, at).trim()
  const name = at < 0 ? '' : spec.slice(at + 1).trim()
  if (!kind || !name || !KIT_ASSET_KINDS.includes(kind as KitAssetKind)) {
    throw new CliError(`${flag} expects <kind>:<name>, got ${JSON.stringify(spec)}`, ExitCode.Usage, [
      `Kinds: ${KIT_ASSET_KINDS.join(', ')}`,
    ])
  }
  return assetKey(kind, name)
}

function parseNameOverride(spec: string): [string, string] {
  const eq = spec.indexOf('=')
  if (eq < 0) {
    throw new CliError(`--name expects <kind>:<name>=<target>, got ${JSON.stringify(spec)}`, ExitCode.Usage)
  }
  const ref = parseAssetRef(spec.slice(0, eq), '--name')
  const target = spec.slice(eq + 1).trim()
  if (!target) {
    throw new CliError(`--name needs a target name after "=", got ${JSON.stringify(spec)}`, ExitCode.Usage)
  }
  return [ref, target]
}

// -- The page beacon ----------------------------------------------------------

// recordKitEvent posts one event and forgets it. The author's tally is not
// worth failing an add over, so nothing here throws.
//
// Without this, a kit added from a terminal would show up on the author's card
// as a copy against zero views and zero clicks, and the funnel would lie. utm
// source marks the add as coming from the CLI; the link's own campaign keys
// ride along so a post that earned the add still gets the credit.
async function recordKitEvent(client: ApiClient, publicId: string, event: KitEvent): Promise<void> {
  try {
    await client.request<void>(`/api/kits/${encodeURIComponent(publicId)}/events`, {
      method: 'POST',
      body: JSON.stringify(event),
    })
  } catch {
    /* the tally is best effort */
  }
}

// -- Reading the outcome ------------------------------------------------------

// addedNames lists everything the copy actually installed, in the order the
// server creates them.
export function addedNames(result: KitCopyResult): { kind: string; name: string }[] {
  const out: { kind: string; name: string }[] = []
  for (const name of result.skills ?? []) out.push({ kind: 'skill', name })
  for (const name of result.profiles ?? []) out.push({ kind: 'agent', name })
  if (result.pool) out.push({ kind: 'pod', name: result.pool })
  for (const name of result.automations ?? (result.automation ? [result.automation] : [])) {
    out.push({ kind: 'schedule', name })
  }
  return out
}

// A kit that installed nothing pinnable (a skill-only kit, or an add that
// skipped the pod and the agents) is not a failed pin, and must not be reported
// as one.
export type PinOutcome = 'pinned' | 'failed' | 'nothing'

// pinAdded pins what was added, because the kit page promises "pinned on Home"
// and an add from the terminal lands in the same place as an add from the
// browser. A pod is pinned as one thing; a kit with no pod pins its agents.
//
// Every pin is attempted, the way the dashboard's Promise.all over pinAgent
// attempts every one: a kit whose second agent fails to pin should still have
// its first and third pinned. Best effort overall, since a pin that did not
// take leaves the agent in Browse, which is worth a line on stderr and never a
// failed add.
async function pinAdded(client: ApiClient, result: KitCopyResult): Promise<PinOutcome> {
  const paths = result.pool
    ? [`/api/pools/${encodeURIComponent(result.pool)}/pin`]
    : (result.profiles ?? []).map((name) => `/api/profiles/${encodeURIComponent(name)}/pin`)
  if (paths.length === 0) return 'nothing'
  const settled = await Promise.allSettled(
    paths.map((path) => client.request<void>(path, { method: 'POST' })),
  )
  return settled.every((outcome) => outcome.status === 'fulfilled') ? 'pinned' : 'failed'
}

// -- Rendering ----------------------------------------------------------------

// planRowStatus is the one word that says what will happen to an asset:
// skipped, renamed (the name is taken here, so the server suggested another),
// or the plan's own new/changed/unchanged against a previous add.
function planRowStatus(row: KitSelectionRow): string {
  if (!row.selected) return 'skipped'
  if (row.collision) return 'renamed'
  return row.status
}

function planRowCells(row: KitSelectionRow): string[] {
  return [row.kind, row.name, planRowStatus(row), row.selected ? row.targetName : '-']
}

async function renderPlan(kit: Kit, rows: KitSelectionRow[], hint?: string): Promise<void> {
  const { Table } = await import('../ui/Table.js')
  const { Panel } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  const selected = rows.filter((row) => row.selected).length
  await renderStatic(
    <Panel title="ADD KIT" subtitle={`${kit.label}  ${selected} of ${rows.length} assets`}>
      <Table
        columns={[
          { header: 'kind', get: (row: KitSelectionRow) => row.kind },
          {
            header: 'in the kit',
            get: (row: KitSelectionRow) => row.name,
            color: () => theme.accent,
            bold: true,
          },
          { header: 'status', get: planRowStatus },
          { header: 'added as', get: (row: KitSelectionRow) => (row.selected ? row.targetName : '-') },
        ]}
        rows={rows}
        headers
        hint={hint}
      />
    </Panel>,
  )
}

async function renderResult(kit: Kit, result: KitCopyResult, pinned: boolean): Promise<void> {
  const { Table } = await import('../ui/Table.js')
  const { Panel } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  const rows = addedNames(result)
  const next = result.pool
    ? `orca pools get ${result.pool}`
    : result.profiles?.[0]
      ? `orca run ${result.profiles[0]} "..."`
      : undefined
  await renderStatic(
    <Panel title="KIT ADDED" subtitle={pinned ? `${kit.label} ${glyphs.separator} pinned on Home` : kit.label}>
      <Table
        columns={[
          { header: 'kind', get: (row: { kind: string }) => row.kind },
          {
            header: 'name',
            get: (row: { name: string }) => row.name,
            color: () => theme.accent,
            bold: true,
          },
        ]}
        rows={rows}
        headers
        hint={next}
      />
    </Panel>,
  )
}

// -- The command --------------------------------------------------------------

export function registerKits(program: Command): void {
  const kit = program
    .command('kit')
    .alias('kits')
    .description('add a shared kit to your workspace')

  kit
    .command('add <link>')
    .description('add the kit behind a share link, renaming anything that collides')
    .option(
      '--name <kind:name=target>',
      'install one asset under a different name (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--skip <kind:name>',
      'leave one asset out of the add (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--dry-run', 'show what would be added and stop')
    .option('--no-pin', 'do not pin what was added on Home')
    .option('--yes', 'skip the confirmation prompt')
    .action(
      async (
        link: string,
        opts: { name: string[]; skip: string[]; dryRun?: boolean; pin: boolean; yes?: boolean },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const mode = outputMode(flags)
        const { publicId, utm } = parseKitLink(link)
        const overrides = new Map(opts.name.map(parseNameOverride))
        const skips = new Set(opts.skip.map((spec) => parseAssetRef(spec, '--skip')))
        for (const key of overrides.keys()) {
          if (skips.has(key)) {
            throw new CliError(`--name and --skip both name "${key}"`, ExitCode.Usage, [
              'Rename it or leave it out, not both.',
            ])
          }
        }

        const api = await apiContext(cmd)
        const kitRow = await fetchKit(api, publicId)

        // A kit that links out installs nothing anywhere: its page offers a
        // link instead of Add kit, and the conductor refuses to copy it.
        if (kitRow.action) {
          if (mode === 'json') {
            printJson({ publicId, label: kitRow.label, added: false, action: kitRow.action })
            return
          }
          if (mode === 'plain') {
            printPlainRows([[kitRow.label, kitRow.action.label, kitRow.action.url]])
            return
          }
          console.error(hintText(`"${kitRow.label}" is a link, not an install.`))
          console.error(hintText(`  ${kitRow.action.label}: ${kitRow.action.url}`))
          return
        }

        const plan = await withApi(api, (c) =>
          c.request<KitCopyPlan>(
            `/api/templates/${encodeURIComponent(kitRow.slug)}/copy?id=${encodeURIComponent(kitRow.id)}`,
          ),
        )
        const rows = resolvePlanRows(plan, overrides, skips)
        const selections = planSelections(rows)

        if (opts.dryRun) {
          if (mode === 'json') {
            printJson({ publicId, label: kitRow.label, assets: rows })
            return
          }
          if (mode === 'plain') {
            printPlainRows(rows.map(planRowCells))
            return
          }
          await renderPlan(kitRow, rows, `orca kit add ${publicId} --yes`)
          return
        }

        // One visit: the view and the click that follows it share an id, the
        // way the kit page's per-tab id does.
        //
        // Posted here and not on the way in, so a --dry-run is not a visit. The
        // page mints its id once per tab precisely so a reload is not a second
        // view; a fresh process cannot dedup that way, and a dry run is the one
        // shape of this command people put in a loop. Counting each pass would
        // inflate the very tally the beacon exists to keep honest. A view now
        // means someone reached the point of adding the kit, and a cancelled
        // add reads as a view with no click, exactly as it does on the page.
        const visitorId = randomUUID().replace(/-/g, '')
        const beacon = { visitorId, utm: { source: 'cli', ...utm } }
        await recordKitEvent(api.client, publicId, { type: 'view', ...beacon })

        if (!opts.yes) {
          if (!interactive()) {
            throw new CliError('refusing to add a kit without --yes in non-interactive mode', ExitCode.Usage)
          }
          await renderPlan(kitRow, rows)
          if (!(await confirm(`Add "${kitRow.label}" to your workspace?`))) {
            console.error(hintText('Aborted.'))
            return
          }
        }

        await recordKitEvent(api.client, publicId, { type: 'click', target: 'primary', ...beacon })
        const result = await copyKit(api, kitRow, selections)

        // The mapped copy path answers copied=false only when every selected
        // asset lost a race to something created since the plan was read.
        if (!result.copied) {
          throw new CliError('nothing was added: every name was taken during the add', ExitCode.Failure, [
            'Nothing was overwritten. Run the command again to pick up fresh names.',
          ])
        }

        const pin: PinOutcome = opts.pin ? await pinAdded(api.client, result) : 'nothing'
        const skipped = result.skipped ?? []

        if (mode === 'json') {
          printJson({ ...result, pinned: pin === 'pinned' })
        } else if (mode === 'plain') {
          printPlainRows(addedNames(result).map((row) => [row.kind, row.name]))
        } else {
          await renderResult(kitRow, result, pin === 'pinned')
        }

        if (skipped.length > 0) {
          console.error(
            hintText(
              `${skipped.length} asset${skipped.length === 1 ? '' : 's'} kept the name ${skipped.length === 1 ? 'it' : 'they'} already had here and ${skipped.length === 1 ? 'was' : 'were'} left alone:`,
            ),
          )
          for (const item of skipped) console.error(hintText(`  ${item.kind} "${item.targetName}"`))
        }
        if (pin === 'failed') {
          console.error(hintText('Added, but could not pin it on Home. Pin it from the agent page.'))
        }
        if (result.automations?.length || result.automation) {
          console.error(hintText('Schedules arrive paused. Start one with: orca workflows'))
        }
      },
    )
}

// fetchKit resolves the share link's public id into the kit row, naming the two
// dead ends a link can hit rather than reporting a bare 404.
async function fetchKit(api: ApiContext, publicId: string): Promise<Kit> {
  return withApi(api, async (c) => {
    try {
      return await c.request<Kit>(`/api/kits/${encodeURIComponent(publicId)}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        throw new CliError(`kit ${publicId} was withdrawn by its author`, ExitCode.NotFound)
      }
      if (err instanceof ApiError && err.status === 404) {
        throw new CliError(`no kit at ${publicId}`, ExitCode.NotFound, [
          'Check the link: it should look like https://app.orcapods.ai/kits/kit-...',
        ])
      }
      throw err
    }
  })
}

// copyKit posts the add, pinned to the kit's row id so a renamed org or a
// reused slug can never redirect it (resolveSharedTemplate prefers id).
//
// A 409 means a name the plan offered was taken between reading the plan and
// posting it. Nothing is overwritten, ever; the fix is a new name, which the
// next plan will suggest.
async function copyKit(
  api: ApiContext,
  kit: Kit,
  assets: KitCopySelection[],
): Promise<KitCopyResult> {
  return withApi(api, async (c) => {
    try {
      return await c.request<KitCopyResult>(
        `/api/templates/${encodeURIComponent(kit.slug)}/copy?id=${encodeURIComponent(kit.id)}`,
        { method: 'POST', body: JSON.stringify({ assets }) },
      )
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { error?: string; conflicts?: { kind?: string; targetName?: string }[] }
        if (body?.error === 'copy_conflicts') {
          const taken = (body.conflicts ?? [])
            .map((item) => `${item.kind} "${item.targetName}"`)
            .join(', ')
          throw new CliError(`name taken: ${taken || 'an asset name'}`, ExitCode.Failure, [
            'Nothing was overwritten. Run the command again for fresh names,',
            'or choose your own with --name <kind>:<name>=<target>.',
          ])
        }
      }
      throw err
    }
  })
}
