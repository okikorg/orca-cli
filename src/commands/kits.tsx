import type { Command } from 'commander'

import { ApiClient, ApiError, extractErrorBody, mapApiError } from '../lib/api.js'
import { requireApiUrl, resolveContext } from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows } from '../lib/output.js'
import type {
  KitCopyAsset,
  KitCopyResult,
  KitCredential,
  KitReview,
  KitReviewCapability,
  KitReviewFile,
  KitReviewTool,
} from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import { apiContext, globalFlags, withApi } from './shared.js'

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

// kitAssets lists everything the reviewed version holds, each with the key
// the copy names it by and the name it is copied under by default.
function kitAssets(review: KitReview): KitCopyAsset[] {
  return [...review.agents, ...review.skills, ...review.templates].map((a) => ({ key: a.key, name: a.name }))
}

// copyPlan applies --name and --skip to a kit's assets and returns the copy
// request's assets. Every asset is copied under its own name unless renamed
// or skipped; the server answers 409 name_taken for a name already in use
// and copies nothing, so a collision is fixed with --name and a rerun.
function copyPlan(review: KitReview, renames: Map<string, string>, skips: Set<string>): KitCopyAsset[] {
  const assets = kitAssets(review)
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

// credentialLine names a credential and where it is added: an MCP server's
// in a vault, a variable on the copied template (named once copied).
function credentialLine(c: KitCredential, copy?: KitCopyResult): string {
  if (c.kind === 'mcp_server') {
    const url = c.server_url ? ` (${c.server_url})` : ''
    return `MCP server credential ${c.name}${url}, used by ${c.used_by}: add it to a vault`
  }
  const template = copy?.created.find((item) => item.key === c.asset)
  const where = template ? `template ${template.name} (${template.id})` : 'the template once copied'
  return `Environment variable ${c.name}, used by ${c.used_by}: set it on ${where}`
}

// fetchReview reads the review of a kit's newest version. It needs no
// credential, so `show` works before login against any server URL.
async function fetchReview(cmd: Command, publicId: string): Promise<KitReview> {
  const ctx = await resolveContext(globalFlags(cmd))
  const apiUrl = requireApiUrl(ctx)
  const client = new ApiClient({ apiUrl, apiKey: ctx.apiKey ?? '', contextName: ctx.name })
  try {
    return await client.kitReview(publicId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new CliError(`no kit at ${publicId}`, ExitCode.NotFound, [
        'Check the link: it should look like https://app.orcapods.ai/kits/kit-...',
      ])
    }
    throw mapApiError(err, { contextName: ctx.name, apiUrl })
  }
}

const repeatable = (value: string, previous: string[]) => [...previous, value]

// -- The review as text ----------------------------------------------------------
// Everything the server's review holds, one fact per line, in its order: the
// publisher, the version, the three summaries as the server wrote them, then
// every asset in full. Text from the kit (descriptions, instructions, setup
// commands, file contents) is quoted with `| ` so it never reads as the
// CLI's own words.

const listed = (values: string[] | null | undefined) => (values?.length ? values.join(', ') : 'none')

function quoted(out: string[], indent: string, body: string | null | undefined): void {
  for (const text of (body ?? '').split('\n')) out.push(`${indent}| ${text}`)
}

const HASH_ONLY: Record<string, string> = {
  binary: 'binary, listed by hash',
  longer_than_64_kib: 'over 64 KiB, listed by hash',
  review_limit: 'past the review\'s 2 MiB, listed by hash',
}

function fileLines(out: string[], indent: string, files: KitReviewFile[]): void {
  if (files.length === 0) out.push(`${indent}none`)
  for (const file of files) {
    const why = file.hash_only ? `  (${HASH_ONLY[file.hash_only] ?? `${file.hash_only}, listed by hash`})` : ''
    out.push(`${indent}${file.path}  ${file.size_bytes} bytes  sha256 ${file.sha256}${why}`)
    if (file.content != null) quoted(out, `${indent}  `, file.content)
  }
}

function toolLine(tool: KitReviewTool): string {
  const t = tool as Record<string, unknown> & { type: string }
  if (t.type === 'web_search') {
    const domains = t.allowed_domains == null ? 'any' : listed(t.allowed_domains as string[])
    return `web search, mode ${String(t.mode ?? 'default')}, context ${String(t.context_size ?? 'default')}, domains ${domains}`
  }
  if (t.type === 'function') return `function ${String(t.name)}: ${String(t.description ?? '')}`
  if (t.type === 'mcp') {
    const transport = (t.transport ?? {}) as Record<string, unknown>
    const allowed = t.allowed_tools == null ? 'all' : listed(t.allowed_tools as string[])
    if (transport.type === 'stdio') {
      const command = [String(transport.command), ...((transport.args as string[] | null) ?? [])].join(' ')
      const folder = (transport.cwd as string | null) ?? 'the default folder'
      const env = listed(transport.env_var_names as string[] | null)
      return `MCP ${String(t.server_label)} over stdio: ${command}, in ${folder}, allowed tools ${allowed}, environment variable names ${env}`
    }
    const headers = listed(transport.header_names as string[] | null)
    return `MCP ${String(t.server_label)} over HTTP: ${String(transport.server_url)}, allowed tools ${allowed}, header names ${headers}`
  }
  return t.type
}

function capabilityLines(out: string[], capabilities: KitReviewCapability[]): void {
  if (capabilities.length === 0) out.push('    none')
  for (const capability of capabilities) {
    if (capability.type === 'kit_skill') {
      out.push(`    - the kit's ${capability.key}`)
      continue
    }
    out.push(`    - inline ${capability.name}: ${capability.description ?? ''}`)
    fileLines(out, '      ', capability.files)
  }
}

export function reviewLines(review: KitReview): string[] {
  const out: string[] = [accentVerb(review.name)]
  if (review.publisher?.orca) out.push('  by Orca')
  out.push(`  ${review.public_id} · version ${review.version} · published ${formatTime(review.published_at)}`)
  if (review.description) quoted(out, '  ', review.description)
  for (const [label, lines] of [
    ['Runs code', review.summary.runs_code],
    ['Reaches', review.summary.reaches],
    ['Spends', review.summary.spends],
  ] as const) {
    out.push('', `${label}:`)
    if (lines.length === 0) out.push('  - none')
    for (const line of lines) out.push(`  - ${line}`)
  }
  for (const agent of review.agents) {
    out.push('', `Agent ${agent.key}: ${agent.name}`)
    out.push(`  Model: ${agent.model ?? 'none'}`)
    out.push(`  Reasoning effort: ${agent.reasoning_effort ?? 'default'}`)
    out.push(`  Service tier: ${agent.service_tier ?? 'default'}`)
    out.push(
      agent.team.enabled
        ? `  Team: yes, at most ${agent.team.max_concurrent_subagents ?? 'the default number of'} subagents at once`
        : '  Team: no',
    )
    out.push('  Instructions:')
    quoted(out, '    ', agent.instructions)
    out.push('  Tools:')
    if (agent.tools.length === 0) out.push('    none')
    for (const tool of agent.tools) out.push(`    - ${toolLine(tool)}`)
  }
  for (const skill of review.skills) {
    out.push('', `Skill ${skill.key}: ${skill.name}`)
    if (skill.description) quoted(out, '  ', skill.description)
    out.push('  Files:')
    fileLines(out, '    ', skill.files)
  }
  for (const template of review.templates) {
    out.push('', `Template ${template.key}: ${template.name}`)
    const network = template.network
    out.push(
      network.access === 'restricted'
        ? `  Network: restricted to ${listed(network.allowed_domains)}`
        : `  Network: ${network.access ?? 'disabled'}`,
    )
    for (const kind of ['system', 'python', 'npm'] as const) {
      out.push(`  Packages, ${kind}: ${listed(template.packages?.[kind])}`)
    }
    out.push('  Setup commands, in order:')
    const setup = template.setup_commands ?? []
    if (setup.length === 0) out.push('    none')
    setup.forEach((command, n) => {
      out.push(`    ${n + 1}. in ${command.cwd ?? 'the workspace'}`)
      quoted(out, '      ', command.command)
    })
    out.push(`  Capability directories: ${listed(template.capability_directories)}`)
    out.push('  Files:')
    fileLines(out, '    ', template.files)
    out.push('  Skills:')
    capabilityLines(out, template.skills)
    out.push('  Plugins:')
    capabilityLines(out, template.plugins)
  }
  out.push('', 'Credentials to add after copying:')
  if (review.credentials.length === 0) out.push('  none')
  for (const c of review.credentials) out.push(`  - ${credentialLine(c)}`)
  return out
}

export function registerKits(program: Command): void {
  const kits = program
    .command('kits')
    .alias('kit')
    .description('read and copy the kits Orca publishes: agents, skills, and templates, ready to copy in')

  kits
    .command('show <link>')
    .description('print everything a kit holds, by its share link or public id (no login needed)')
    .action(async (link: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const review = await fetchReview(cmd, parseKitLink(link))
      if (outputMode(flags) === 'json') {
        printJson(review)
        return
      }
      process.stdout.write(reviewLines(review).join('\n') + '\n')
      console.error(hintText(`Copy it after a yes: orca kits copy ${review.public_id}`))
    })

  kits
    .command('copy <link>')
    .description('print a kit\'s review, then copy the version shown into this organization after a yes')
    .option('--name <key=name>', 'copy one asset under a different name (repeatable)', repeatable, [] as string[])
    .option('--skip <key>', 'leave one asset out (repeatable)', repeatable, [] as string[])
    .option('--dry-run', 'print the review and what would be copied, and stop')
    .option('--yes', 'skip the question, only after the person has read the review and said yes')
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
        const review = await fetchReview(cmd, publicId)
        const assets = copyPlan(review, renames, skips)

        // The review goes to stderr, so stdout stays the copy's result.
        console.error(reviewLines(review).join('\n') + '\n')
        if (opts.dryRun) {
          if (mode === 'json') printJson({ public_id: publicId, version: review.version, assets })
          else printPlainRows(assets.map((a) => [a.key, a.name]))
          return
        }
        if (!opts.yes) {
          if (!interactive()) {
            throw new CliError('refusing to copy a kit without --yes in non-interactive mode', ExitCode.Usage, [
              'Show the person the review above, and pass --yes only after they say yes.',
            ])
          }
          for (const a of assets) console.error(hintText(`  ${a.key} as "${a.name}"`))
          if (!(await confirm(`Copy "${review.name}" version ${review.version} into this organization?`))) {
            console.error(hintText('Aborted.'))
            return
          }
        }

        const result = await withApi(api, async (c) => {
          try {
            return await c.copyKit(publicId, review.version, assets)
          } catch (err) {
            if (err instanceof ApiError && err.code === 'name_taken') {
              throw new CliError(extractErrorBody(err.body) || 'a name is taken', ExitCode.Failure, [
                'Nothing was copied. Choose another name with --name <key>=<name> and run it again.',
              ])
            }
            if (err instanceof ApiError && err.code === 'kit_changed') {
              // A newer version was published after the review above: show
              // it, copy nothing, and leave the decision to the person.
              const fresh = await fetchReview(cmd, publicId)
              console.error('This kit changed while you were reading. Here is the new version.\n')
              console.error(reviewLines(fresh).join('\n') + '\n')
              throw new CliError('nothing was copied', ExitCode.Failure, [
                `Read version ${fresh.version} above, and run the copy again to copy it.`,
              ])
            }
            throw err
          }
        })
        reportCopy(result, mode)
      },
    )
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
    for (const c of result.credentials) console.error(hintText(`  ${credentialLine(c, result)}`))
  }
}
