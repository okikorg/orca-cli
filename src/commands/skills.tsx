import { promises as fs } from 'node:fs'
import path from 'node:path'

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
import {
  collectSkillPackageFiles,
  encodeResourcePath,
  type Skill,
  type SkillPackagePreview,
} from '../lib/skills.js'
import type { AgentProfile } from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import {
  addPageFlags,
  apiContext,
  type ApiContext,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type PageFlags,
} from './shared.js'

const enc = encodeURIComponent

// mapAttachDetachError narrows the dedicated attach/detach endpoint's status
// codes onto the exit-code contract. The profile has already been fetched, so a
// 404 here is a missing skill (usage), not a missing agent.
function mapSkillEndpointError(err: unknown, api: ApiContext, skill: string): CliError {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return new CliError(
        `skill "${skill}" is not in the catalog; import it first with: orca skills import <path>`,
        ExitCode.Usage,
      )
    }
    if (err.status === 501) {
      return new CliError('the server does not support modifying skills on this agent', ExitCode.Failure)
    }
  }
  return mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
}

// renderSkillDetail renders one skill as a coral-titled panel plus the SKILL.md
// body as plain text, mirroring agents' renderAgentDetail.
async function renderSkillDetail(skill: Skill): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { Box, Text } = await import('ink')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title={skill.name} subtitle={skill.source ?? 'user'}>
      {skill.description ? <Field label="description" value={skill.description} /> : null}
      {skill.tags?.length ? <Field label="tags" value={skill.tags.join(', ')} /> : null}
      {skill.license ? <Field label="license" value={skill.license} /> : null}
      {skill.compatibility ? <Field label="compatibility" value={skill.compatibility} /> : null}
      {skill.resources?.length ? (
        <Field label="resources" value={skill.resources.map((r) => r.path).join(', ')} />
      ) : null}
      {skill.requiresSandbox ? <Field label="sandbox" value="required (bundles scripts/)" /> : null}
      {skill.body ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.subtle}>body</Text>
          <Text color={theme.muted}>{skill.body}</Text>
        </Box>
      ) : null}
    </Panel>,
  )
}

// fetchResource reads one raw resource file. The route returns bytes, not JSON,
// so it bypasses ApiClient.request (which JSON-parses every body).
async function fetchResource(api: ApiContext, name: string, resourcePath: string): Promise<string> {
  const url = api.client.url(`/api/skills/${enc(name)}/resources/${encodeResourcePath(resourcePath)}`)
  const res = await fetch(url, { headers: api.client.headers(), signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(`${res.status} ${res.statusText}`, res.status, body)
  }
  return res.text()
}

// uploadSkillPackage posts the multipart folder for a dry-run preview. It reuses
// the client's auth header but drops Content-Type so fetch sets the multipart
// boundary itself (same pattern as dashboard importSkillPackageDryRun).
async function uploadSkillPackage(api: ApiContext, dir: string): Promise<SkillPackagePreview> {
  const files = await collectSkillPackageFiles(dir)
  const form = new FormData()
  for (const f of files) {
    // Copy into a fresh ArrayBuffer-backed view: fs.readFile yields a Buffer
    // over ArrayBufferLike, which the Blob part type does not accept directly.
    form.append('files', new Blob([new Uint8Array(f.bytes)]), f.relPath)
  }
  const headers = api.client.headers()
  delete headers['Content-Type']
  const res = await fetch(api.client.url('/api/skills/import-package?dryRun=1'), {
    method: 'POST',
    body: form,
    headers,
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(`${res.status} ${res.statusText}`, res.status, body)
  }
  return (await res.json()) as SkillPackagePreview
}

export function registerSkills(program: Command): void {
  const skills = program.command('skills').description('manage the skill catalog')

  const skillsList = skills.command('list').description('list skills in the catalog')
  addPageFlags(skillsList)
  skillsList.action(async (opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<Skill>(opts, (params) =>
        withApi(api, (c) => c.listSkills<Skill>(params)),
      )
      const list = page.items
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(list)
        return
      }
      if (list.length === 0) {
        // Empty state names the command that creates the missing thing.
        console.error(hintText('No skills yet.'))
        console.error(hintText('  import one: orca skills import <path>'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          list.map((s) => [s.name, s.source ?? 'user', String(s.resources?.length ?? 0), s.description ?? '-']),
        )
        printPageHint(list.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Table
          title="Skills"
          meta={pagedSubtitle(list.length, page.total)}
          hint='orca skills get <name> · orca skills attach <agent> <name>'
          columns={[
            { header: 'name', get: (s: Skill) => s.name, color: () => theme.accent, bold: true },
            { header: 'source', get: (s: Skill) => s.source ?? 'user' },
            { header: 'files', get: (s: Skill) => String(s.resources?.length ?? 0) },
            { header: 'description', get: (s: Skill) => s.description ?? '-' },
          ]}
          rows={list}
        />,
      )
      printPageHint(list.length, page.total)
    })

  skills
    .command('get <name>')
    .description('show one skill (metadata + body), or a resource file with --resource')
    .option('--resource <path>', 'print a bundled resource file instead of the skill body')
    .action(async (name: string, opts: { resource?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const mode = outputMode(flags)

      if (opts.resource) {
        const content = await withApi(api, () => fetchResource(api, name, opts.resource as string))
        if (mode === 'json') {
          printJson({ name, path: opts.resource, content })
          return
        }
        process.stdout.write(content)
        return
      }

      const skill = await withApi(api, (c) => c.request<Skill>(`/api/skills/${enc(name)}`))
      if (mode === 'json') {
        printJson(skill)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['name', skill.name],
          ['source', skill.source ?? 'user'],
          ['description', skill.description ?? '-'],
          ['tags', skill.tags?.join(',') ?? '-'],
          ['resources', String(skill.resources?.length ?? 0)],
        ])
        return
      }
      await renderSkillDetail(skill)
    })

  skills
    .command('delete <name>')
    .description('delete a skill from the catalog')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete skill "${name}"?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.request<void>(`/api/skills/${enc(name)}`, { method: 'DELETE' }))
      if (outputMode(flags) === 'json') printJson({ name, deleted: true })
      else console.log(`${accentVerb('Deleted')} skill "${name}".`)
    })

  skills
    .command('import <path>')
    .description('import an Agent Skills folder (must contain SKILL.md)')
    .option('--dry-run', 'validate and preview without registering')
    .option('--force', 'overwrite an existing skill of the same name')
    .action(async (target: string, opts: { dryRun?: boolean; force?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const json = outputMode(flags) === 'json'

      const dir = path.resolve(target)
      const stat = await fs.stat(dir).catch(() => null)
      if (!stat || !stat.isDirectory()) {
        throw new CliError(`not a directory: ${target}`, ExitCode.Usage, [
          'Point at an Agent Skills folder that contains a SKILL.md file.',
        ])
      }
      const hasSkillFile = await fs
        .stat(path.join(dir, 'SKILL.md'))
        .then((s) => s.isFile())
        .catch(() => false)
      if (!hasSkillFile) {
        throw new CliError(`no SKILL.md in ${target}`, ExitCode.Usage, [
          'An Agent Skills folder must have a SKILL.md at its root.',
        ])
      }

      try {
        const preview = await uploadSkillPackage(api, dir)

        if (!preview.validation.ok) {
          for (const e of preview.validation.errors) console.error(`error: ${e}`)
          throw new CliError(`skill package "${preview.skill.name}" failed validation`, ExitCode.Usage)
        }
        for (const w of preview.validation.warnings) console.error(`warning: ${w}`)

        if (opts.dryRun) {
          if (json) {
            printJson(preview)
          } else {
            console.error(
              `${preview.skill.name}: ${preview.resources.length} resource file(s), ${preview.totalBytes} bytes` +
                (preview.requiresSandbox ? ' (requires sandbox)' : ''),
            )
            console.log(`Validated skill "${preview.skill.name}". Re-run without --dry-run to register it.`)
          }
          return
        }

        const created = await api.client.request<Skill>('/api/skills/import-package/commit', {
          method: 'POST',
          body: JSON.stringify({ stagingId: preview.stagingId, force: opts.force ?? false }),
        })
        if (json) printJson(created)
        else console.log(`${accentVerb('Imported')} skill "${created.name}" (${created.resources?.length ?? 0} resource file(s)).`)
      } catch (err) {
        if (err instanceof CliError) throw err
        if (err instanceof ApiError && err.status === 409) {
          throw new CliError(`skill already exists; re-run with --force to overwrite`, ExitCode.Failure)
        }
        throw mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
      }
    })

  skills
    .command('attach <agent> <skill>')
    .description('attach a skill to an agent profile')
    .action(async (agent: string, skill: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const json = outputMode(flags) === 'json'

      // Read first: a 404 here is a missing agent (exit 4). The write still
      // goes through the dedicated idempotent endpoint, not a whole-profile PUT.
      const profile = await withApi(api, (c) => c.request<AgentProfile>(`/api/profiles/${enc(agent)}`))
      if (profile.skills?.includes(skill)) {
        if (json) printJson({ agent, skill, attached: true, changed: false })
        else console.log(`Skill "${skill}" is already attached to "${agent}".`)
        return
      }

      try {
        await api.client.request<void>(`/api/profiles/${enc(agent)}/skills/${enc(skill)}`, { method: 'POST' })
      } catch (err) {
        throw mapSkillEndpointError(err, api, skill)
      }
      if (json) printJson({ agent, skill, attached: true, changed: true })
      else console.log(`${accentVerb('Attached')} skill "${skill}" to "${agent}".`)
    })

  skills
    .command('detach <agent> <skill>')
    .description('detach a skill from an agent profile')
    .action(async (agent: string, skill: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const json = outputMode(flags) === 'json'

      const profile = await withApi(api, (c) => c.request<AgentProfile>(`/api/profiles/${enc(agent)}`))
      if (!profile.skills?.includes(skill)) {
        if (json) printJson({ agent, skill, detached: true, changed: false })
        else console.log(`Skill "${skill}" is not attached to "${agent}".`)
        return
      }

      try {
        await api.client.request<void>(`/api/profiles/${enc(agent)}/skills/${enc(skill)}`, { method: 'DELETE' })
      } catch (err) {
        throw mapSkillEndpointError(err, api, skill)
      }
      if (json) printJson({ agent, skill, detached: true, changed: true })
      else console.log(`${accentVerb('Detached')} skill "${skill}" from "${agent}".`)
    })
}
