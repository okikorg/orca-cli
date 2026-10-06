import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { Command } from 'commander'
import type { Skill } from 'openai/resources/skills/skills'

import { toPage } from '../lib/api.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { collectSkillFiles } from '../lib/skills.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import {
  addPageFlags,
  apiContext,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type PageFlags,
} from './shared.js'

// Skills are versioned Agent Skills folders on /v1/skills. An environment
// template mounts them into a session's workspace.
export function registerSkills(program: Command): void {
  const skills = program.command('skills').description('manage skills')

  const skillsList = skills.command('list').description('list skills, newest first')
  addPageFlags(skillsList)
  skillsList.action(async (opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, async (c) => toPage(await (await c.v1()).skills.list(params))),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No skills yet.'))
      console.error(hintText('  upload one: orca skills create <folder>'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(page.items.map((s) => [s.id, s.name, s.default_version, s.description.replace(/\s+/g, ' ').trim()]))
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Skills"
        meta={pagedSubtitle(page)}
        hint="orca skills get <id> · orca skills create <folder>"
        columns={[
          { header: 'name', get: (s: Skill) => s.name, color: () => theme.accent, bold: true },
          { header: 'version', get: (s: Skill) => s.default_version },
          { header: 'description', get: (s: Skill) => s.description.replace(/\s+/g, ' ').trim() || '-' },
          { header: 'id', get: (s: Skill) => s.id, color: () => theme.subtle },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })

  skills
    .command('get <id>')
    .description('show one skill')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const skill = await withApi(api, async (c) => (await c.v1()).skills.retrieve(id))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(skill)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['id', skill.id],
          ['name', skill.name],
          ['defaultVersion', skill.default_version],
          ['latestVersion', skill.latest_version],
          ['created', formatTime(skill.created_at)],
        ])
        return
      }
      const { Panel, Field } = await import('../ui/Panel.js')
      await renderStatic(
        <Panel title={skill.name} subtitle={skill.id}>
          <Field label="description" value={skill.description.replace(/\s+/g, ' ').trim() || '-'} />
          <Field label="version" value={`${skill.default_version} (latest ${skill.latest_version})`} />
          <Field label="created" value={formatTime(skill.created_at)} />
        </Panel>,
      )
    })

  skills
    .command('create <folder>')
    .description('upload an Agent Skills folder (it must contain SKILL.md) as a new skill')
    .action(async (target: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const dir = path.resolve(target)
      const stat = await fs.stat(dir).catch(() => null)
      if (!stat || !stat.isDirectory()) {
        throw new CliError(`not a directory: ${target}`, ExitCode.Usage, [
          'Point at an Agent Skills folder that contains a SKILL.md file.',
        ])
      }
      const files = await collectSkillFiles(dir)
      if (!files.some((f) => f.relPath === 'SKILL.md')) {
        throw new CliError(`no SKILL.md in ${target}`, ExitCode.Usage, [
          'An Agent Skills folder must have a SKILL.md at its root.',
        ])
      }
      const api = await apiContext(cmd)
      const { toFile } = await import('openai/uploads')
      // A directory upload: each part's filename is its path under the
      // folder's own name, as the server expects.
      const folder = path.basename(dir)
      const uploads = await Promise.all(files.map((f) => toFile(f.bytes, `${folder}/${f.relPath}`)))
      const skill = await withApi(api, async (c) => (await c.v1()).skills.create({ files: uploads }))
      if (outputMode(flags) === 'json') printJson(skill)
      else console.log(`${accentVerb('Created')} skill "${skill.name}" (${skill.id}).`)
    })

  skills
    .command('delete <id>')
    .description('delete a skill and all its versions')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete skill ${id}?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, async (c) => (await c.v1()).skills.delete(id))
      if (outputMode(flags) === 'json') printJson({ id, deleted: true })
      else console.log(`${accentVerb('Deleted')} skill ${id}.`)
    })
}
