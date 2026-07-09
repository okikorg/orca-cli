import type { Command } from 'commander'

import { ApiError, mapApiError } from '../lib/api.js'
import { CliError, ExitCode } from '../lib/errors.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderStatic,
} from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import {
  addPageFlags,
  apiContext,
  fetchAll,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type PageFlags,
} from './shared.js'

// -- Wire shapes (mirrors agent-runtime/types/pool.go + the Pool schema in
//    docs/openapi.sdk.yaml) ----------------------------------------------------

type PoolMember = { profile: string; role?: string }

// Extra glob lists the pool contributes to every member's effective FS policy.
// Read/Write/Delete are additive; Deny subtracts. Tokens {self}/{pool}/{role}
// are substituted server-side at policy compile time.
type PoolFSPolicy = {
  read?: string[]
  write?: string[]
  delete?: string[]
  deny?: string[]
}

// A named group of profiles that share an FS workspace under /pools/{name}/**.
// `id` is auto-assigned server-side ("pool-<hex>"); `members` is required by
// the schema but may be empty.
type AgentPool = {
  id?: string
  name: string
  description?: string
  members: PoolMember[]
  fs?: PoolFSPolicy
}

// Roles recognised by the runtime; unknown roles fall back to member.
const VALID_ROLES = new Set(['lead', 'member', 'observer'])

function assertRole(raw: string): string {
  const role = raw.trim().toLowerCase()
  if (!VALID_ROLES.has(role)) {
    throw new CliError(`invalid role "${raw}"`, ExitCode.Usage, [
      'Role must be one of: lead, member, observer.',
    ])
  }
  return role
}

// collectMember is the commander reducer for the repeatable --member flag.
function collectMember(value: string, acc: string[]): string[] {
  acc.push(value)
  return acc
}

// collectGlob is the reducer for the repeatable fs glob flags.
function collectGlob(value: string, acc: string[]): string[] {
  acc.push(value)
  return acc
}

// parseMember turns "profile" or "profile:role" into a PoolMember, validating
// the role half when present.
function parseMember(spec: string): PoolMember {
  const trimmed = spec.trim()
  const colon = trimmed.indexOf(':')
  if (colon < 0) {
    if (trimmed === '') throw new CliError('--member must not be empty', ExitCode.Usage)
    return { profile: trimmed }
  }
  const profile = trimmed.slice(0, colon).trim()
  const role = assertRole(trimmed.slice(colon + 1))
  if (profile === '') {
    throw new CliError(`--member "${spec}" is missing a profile name`, ExitCode.Usage)
  }
  return { profile, role }
}

function poolPath(name: string): string {
  return `/api/pools/${encodeURIComponent(name)}`
}

// membersCell / roleSummary keep member rendering consistent across sinks.
function membersCell(p: AgentPool): string {
  const members = p.members ?? []
  if (members.length === 0) return '-'
  return members.map((m) => (m.role ? `${m.profile} (${m.role})` : m.profile)).join(', ')
}

function fsCell(list?: string[]): string {
  return list && list.length > 0 ? list.join(', ') : '-'
}

async function renderPoolDetail(p: AgentPool): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  await renderStatic(
    <Panel title={p.name} subtitle={p.id || 'pool'}>
      {p.description ? <Field label="description" value={p.description} /> : null}
      <Field label="members" value={membersCell(p)} />
      {p.fs?.read?.length ? <Field label="read" value={fsCell(p.fs.read)} /> : null}
      {p.fs?.write?.length ? <Field label="write" value={fsCell(p.fs.write)} /> : null}
      {p.fs?.delete?.length ? <Field label="delete" value={fsCell(p.fs.delete)} /> : null}
      {p.fs?.deny?.length ? <Field label="deny" value={fsCell(p.fs.deny)} /> : null}
    </Panel>,
  )
}

export function registerPools(program: Command): void {
  const pools = program
    .command('pools')
    .description('manage agent pools (named profile groups sharing an FS workspace)')

  // -- list -------------------------------------------------------------------
  const poolsList = pools.command('list').description('list pools')
  addPageFlags(poolsList)
  poolsList.action(async (opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<AgentPool>(opts, (params) =>
        withApi(api, (c) => c.listPools<AgentPool>(params)),
      )
      const list = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(list)
        return
      }
      if (list.length === 0) {
        // Empty state names the command that creates the missing thing.
        console.error(hintText('No pools yet.'))
        console.error(hintText('  create one: orca pools create NAME --member profile:lead'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          list.map((p) => [p.name, String((p.members ?? []).length), membersCell(p), p.description ?? '-']),
        )
        printPageHint(list.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Table
          title="Pools"
          meta={pagedSubtitle(list.length, page.total)}
          hint='orca pools get <name> · orca pools members add <name> <profile>'
          columns={[
            { header: 'name', get: (p: AgentPool) => p.name, color: () => theme.accent, bold: true },
            { header: 'members', get: (p: AgentPool) => String((p.members ?? []).length) },
            { header: 'profiles', get: membersCell },
            { header: 'description', get: (p: AgentPool) => p.description ?? '-' },
          ]}
          rows={list}
        />,
      )
      printPageHint(list.length, page.total)
    })

  // -- get --------------------------------------------------------------------
  // The API has no GET /api/pools/{name}; the list is the only read surface,
  // so we fetch it and pick the one pool out, 404-ing when it is absent. Page
  // through the whole set (the server caps a single request at 200) so the
  // lookup never silently misses a pool past the first page.
  pools
    .command('get <name>')
    .description('show one pool')
    .action(async (name: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const list = (await fetchAll<AgentPool>((params) =>
        withApi(api, (c) => c.listPools<AgentPool>(params)),
      )).items
      const pool = list.find((p) => p.name === name)
      if (!pool) {
        throw new CliError(`not found: pool "${name}"`, ExitCode.NotFound)
      }
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(pool)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['name', pool.name],
          ['id', pool.id ?? '-'],
          ['description', pool.description ?? '-'],
          ['members', membersCell(pool)],
          ['read', fsCell(pool.fs?.read)],
          ['write', fsCell(pool.fs?.write)],
          ['delete', fsCell(pool.fs?.delete)],
          ['deny', fsCell(pool.fs?.deny)],
        ])
        return
      }
      await renderPoolDetail(pool)
    })

  // -- create -----------------------------------------------------------------
  pools
    .command('create <name>')
    .description('create a pool')
    .option('--description <text>', 'human-readable description')
    .option(
      '--member <profile[:role]>',
      'add a member as profile or profile:role (repeatable)',
      collectMember,
      [],
    )
    .option('--read <glob>', 'extra pool read glob (repeatable)', collectGlob, [])
    .option('--write <glob>', 'extra pool write glob (repeatable)', collectGlob, [])
    .option('--delete <glob>', 'extra pool delete glob (repeatable)', collectGlob, [])
    .option('--deny <glob>', 'pool deny glob, overrides allows (repeatable)', collectGlob, [])
    .action(
      async (
        name: string,
        opts: {
          description?: string
          member: string[]
          read: string[]
          write: string[]
          delete: string[]
          deny: string[]
        },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        const members = opts.member.map(parseMember)
        const fs: PoolFSPolicy = {}
        if (opts.read.length > 0) fs.read = opts.read
        if (opts.write.length > 0) fs.write = opts.write
        if (opts.delete.length > 0) fs.delete = opts.delete
        if (opts.deny.length > 0) fs.deny = opts.deny
        const pool: AgentPool = {
          name,
          members,
          ...(opts.description ? { description: opts.description } : {}),
          ...(Object.keys(fs).length > 0 ? { fs } : {}),
        }
        let created: AgentPool
        try {
          created = await api.client.request<AgentPool>('/api/pools', {
            method: 'POST',
            body: JSON.stringify(pool),
          })
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            throw new CliError(`a pool named "${name}" already exists`, ExitCode.Usage, [
              `Update it with: orca pools members add ${name} <profile>`,
            ])
          }
          throw mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
        }
        if (outputMode(flags) === 'json') {
          printJson(created ?? pool)
          return
        }
        console.log(`${accentVerb('Created')} pool "${(created ?? pool).name}".`)
      },
    )

  // -- delete -----------------------------------------------------------------
  pools
    .command('delete <name>')
    .description('delete a pool')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete pool "${name}"?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.request<void>(poolPath(name), { method: 'DELETE' }))
      if (outputMode(flags) === 'json') printJson({ name, deleted: true })
      else console.log(`${accentVerb('Deleted')} pool "${name}".`)
    })

  // -- members ----------------------------------------------------------------
  const members = pools.command('members').description('add or remove pool members')

  members
    .command('add <pool> <profile>')
    .description('add a profile to a pool (idempotent)')
    .option('--role <role>', 'pool role: lead | member | observer')
    .action(
      async (pool: string, profile: string, opts: { role?: string }, cmd: Command) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        const role = opts.role !== undefined ? assertRole(opts.role) : undefined
        const qs = role ? `?role=${encodeURIComponent(role)}` : ''
        await withApi(api, (c) =>
          c.request<void>(
            `/api/pools/${encodeURIComponent(pool)}/members/${encodeURIComponent(profile)}${qs}`,
            { method: 'POST' },
          ),
        )
        if (outputMode(flags) === 'json') {
          printJson({ pool, profile, ...(role ? { role } : {}), added: true })
          return
        }
        console.log(
          `${accentVerb('Added')} "${profile}" to pool "${pool}"${role ? ` as ${role}` : ''}.`,
        )
      },
    )

  members
    .command('remove <pool> <profile>')
    .description('remove a profile from a pool (idempotent)')
    .option('--yes', 'skip the confirmation prompt')
    .action(
      async (pool: string, profile: string, opts: { yes?: boolean }, cmd: Command) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        if (!opts.yes) {
          if (!interactive()) {
            throw new CliError('refusing to remove without --yes in non-interactive mode', ExitCode.Usage)
          }
          if (!(await confirm(`Remove "${profile}" from pool "${pool}"?`))) {
            console.error(hintText('Aborted.'))
            return
          }
        }
        await withApi(api, (c) =>
          c.request<void>(
            `/api/pools/${encodeURIComponent(pool)}/members/${encodeURIComponent(profile)}`,
            { method: 'DELETE' },
          ),
        )
        if (outputMode(flags) === 'json') {
          printJson({ pool, profile, removed: true })
          return
        }
        console.log(`${accentVerb('Removed')} "${profile}" from pool "${pool}".`)
      },
    )
}
