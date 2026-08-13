// Harness templates: run your own agent implementation as a container image.
//
// A template is a named series of immutable, digest-pinned versions plus one
// active pointer. An agent with runtime "custom" points at a template, so
// rolling back is activating an older version rather than editing every agent
// that uses it.
//
// The shape of this command group follows one fact: import is asynchronous.
// The API answers 202 with a pending version and a separate service copies the
// image into the platform registry. So `import` offers --wait, and `activate`
// explains a 409 rather than passing it through.

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
import type { Template, TemplateVersion, TemplateVersionStatus } from '../lib/types.js'
import { accentVerb, hintText, theme } from '../ui/theme.js'
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

// Statuses the importer will still move on. A version in one of these is not
// finished, and --wait keeps polling while any of them holds.
const IN_FLIGHT: TemplateVersionStatus[] = ['pending', 'mirroring', 'preparing']

function isInFlight(status: TemplateVersionStatus): boolean {
  return IN_FLIGHT.includes(status)
}

// What each state means in the user's terms rather than the pipeline's.
const STATUS_HELP: Record<TemplateVersionStatus, string> = {
  pending: 'accepted, waiting to be picked up',
  mirroring: 'copying the image into the platform registry',
  preparing: 'copied, getting it ready to run',
  ready: 'ready to activate',
  failed: 'the copy did not succeed',
}

function statusColor(status: TemplateVersionStatus): string | undefined {
  if (status === 'ready') return theme.accent
  if (status === 'failed') return theme.destructive
  return theme.muted
}

// shortDigest keeps a table row readable. The full value is one `get` away,
// and it is the one field a user compares verbatim against what they pushed.
function shortDigest(digest: string): string {
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest
  return hex.slice(0, 12)
}

// mapTemplateError narrows this surface's 409s, which are the only statuses a
// user can act on and the ones a generic "409: ..." dump explains worst. Every
// other status falls through to the shared mapping.
export function mapTemplateError(err: unknown, api: ApiContext, name: string): CliError {
  if (err instanceof ApiError) {
    if (err.status === 503) {
      return new CliError(
        'the server has no template store configured',
        ExitCode.Failure,
        ['Harness templates need Postgres (POSTGRES_DSN) on the conductor.'],
      )
    }
    if (err.status === 409) {
      const reason = extractError(err.body)
      return new CliError(reason ?? `template "${name}" is in a conflicting state`, ExitCode.Failure)
    }
  }
  return mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
}

function extractError(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const v = (body as { error?: unknown }).error
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

// waitForVersion polls until the version leaves the in-flight states or the
// deadline passes. The server has no long-poll and no event stream for the
// import, so this is a poll by necessity; the interval matches the dashboard's.
export async function waitForVersion(
  api: ApiContext,
  name: string,
  version: number,
  timeoutMs: number,
): Promise<TemplateVersion> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = await withApi(api, (c) => c.listTemplateVersions(name))
    const found = page.items.find((v) => v.version === version)
    // A version that vanishes mid-wait means the template was deleted under
    // us. Reporting "still pending" until the timeout would be a lie.
    if (!found) {
      throw new CliError(
        `version ${version} of "${name}" is no longer listed; was the template deleted?`,
        ExitCode.NotFound,
      )
    }
    if (!isInFlight(found.status)) return found
    if (Date.now() >= deadline) return found
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

async function renderTemplateDetail(
  template: Template,
  versions: TemplateVersion[],
): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { Box, Text } = await import('ink')
  await renderStatic(
    <Panel
      title={template.name}
      subtitle={template.activeVersion ? `v${template.activeVersion} active` : 'no active version'}
    >
      {template.description ? <Field label="description" value={template.description} /> : null}
      <Field label="versions" value={String(versions.length)} />
      {versions.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.subtle}>versions</Text>
          {versions.map((v) => (
            <Text key={v.version} color={theme.muted}>
              {`  v${v.version}  `}
              <Text color={statusColor(v.status)}>{v.status.padEnd(9)}</Text>
              {`  ${shortDigest(v.digest)}`}
              {v.version === template.activeVersion ? '  (active)' : ''}
              {v.failureReason ? `  ${v.failureReason}` : ''}
            </Text>
          ))}
        </Box>
      ) : null}
    </Panel>,
  )
}

export function registerTemplates(program: Command): void {
  const templates = program
    .command('templates')
    .description('manage harness templates (bring your own agent image)')

  const templatesList = templates.command('list').description('list harness templates')
  addPageFlags(templatesList)
  templatesList.action(async (opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll<Template>(opts, (params) =>
      withApi(api, (c) => c.listTemplates(params)),
    )
    const list = page.items
    const mode = outputMode(flags)

    if (mode === 'json') {
      printJson(list)
      return
    }
    if (list.length === 0) {
      console.error(hintText('No harness templates yet.'))
      console.error(hintText('  create one: orca templates create <name>'))
      return
    }
    const activeOf = (t: Template) => (t.activeVersion ? `v${t.activeVersion}` : '-')
    if (mode === 'plain') {
      printPlainRows(list.map((t) => [t.name, activeOf(t), t.description ?? '-']))
      printPageHint(list.length, page.total)
      return
    }
    const { Table } = await import('../ui/Table.js')
    await renderStatic(
      <Table
        title="Harness templates"
        meta={pagedSubtitle(list.length, page.total)}
        hint="orca templates get <name> · orca templates import <name> <image@sha256:...>"
        columns={[
          { header: 'name', get: (t: Template) => t.name, color: () => theme.accent, bold: true },
          { header: 'active', get: activeOf },
          { header: 'description', get: (t: Template) => t.description ?? '-' },
        ]}
        rows={list}
      />,
    )
    printPageHint(list.length, page.total)
  })

  templates
    .command('get <name>')
    .description('show one template and its versions')
    .action(async (name: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const mode = outputMode(flags)

      const template = await withApi(api, (c) => c.getTemplate(name))
      const versions = (await withApi(api, (c) => c.listTemplateVersions(name))).items

      if (mode === 'json') {
        printJson({ ...template, versions })
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['name', template.name],
          ['active', template.activeVersion ? String(template.activeVersion) : '-'],
          ['description', template.description ?? '-'],
          ['versions', String(versions.length)],
        ])
        return
      }
      await renderTemplateDetail(template, versions)
    })

  templates
    .command('create <name>')
    .description('create an empty harness template')
    .option('--description <text>', 'what this harness is for')
    .action(async (name: string, opts: { description?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      let created: Template
      try {
        created = await api.client.createTemplate({ name, description: opts.description })
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          throw new CliError(`a template named "${name}" already exists`, ExitCode.Failure)
        }
        throw mapTemplateError(err, api, name)
      }
      if (outputMode(flags) === 'json') {
        printJson(created)
        return
      }
      console.log(`${accentVerb('Created')} harness template "${created.name}".`)
      console.error(hintText(`  add an image: orca templates import ${created.name} <image@sha256:...>`))
    })

  templates
    .command('delete <name>')
    .description('delete a harness template and every version in it')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        // Name what is lost: the versions are the only record of which image
        // an agent was pinned to.
        if (!(await confirm(`Delete template "${name}" and all of its versions?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      try {
        await api.client.deleteTemplate(name)
      } catch (err) {
        // The server refuses while any agent still points at the template and
        // names the first one it found. That message is the useful part.
        throw mapTemplateError(err, api, name)
      }
      if (outputMode(flags) === 'json') printJson({ name, deleted: true })
      else console.log(`${accentVerb('Deleted')} harness template "${name}".`)
    })

  const versionsCmd = templates
    .command('versions <name>')
    .description('list the versions of a harness template')
  versionsCmd.action(async (name: string, _opts: Record<string, never>, cmd: Command) => {
    const flags = globalFlags(cmd)
    const api = await apiContext(cmd)
    const template = await withApi(api, (c) => c.getTemplate(name))
    const list = (await withApi(api, (c) => c.listTemplateVersions(name))).items
    const mode = outputMode(flags)

    if (mode === 'json') {
      printJson(list)
      return
    }
    if (list.length === 0) {
      console.error(hintText(`No versions in "${name}" yet.`))
      console.error(hintText(`  import one: orca templates import ${name} <image@sha256:...>`))
      return
    }
    const activeMark = (v: TemplateVersion) => (v.version === template.activeVersion ? 'yes' : '')
    if (mode === 'plain') {
      printPlainRows(
        list.map((v) => [
          String(v.version),
          v.status,
          shortDigest(v.digest),
          activeMark(v),
          v.failureReason ?? '',
        ]),
      )
      return
    }
    const { Table } = await import('../ui/Table.js')
    await renderStatic(
      <Table
        title={`${name} versions`}
        meta={pagedSubtitle(list.length, list.length)}
        hint={`orca templates activate ${name} <version>`}
        columns={[
          {
            header: 'version',
            get: (v: TemplateVersion) => `v${v.version}`,
            color: () => theme.accent,
            bold: true,
          },
          {
            header: 'status',
            get: (v: TemplateVersion) => v.status,
            color: (v: TemplateVersion) => statusColor(v.status),
          },
          { header: 'digest', get: (v: TemplateVersion) => shortDigest(v.digest) },
          { header: 'active', get: activeMark },
          {
            header: 'note',
            get: (v: TemplateVersion) => v.failureReason ?? STATUS_HELP[v.status],
          },
        ]}
        rows={list}
      />,
    )
  })

  templates
    .command('import <name> <image>')
    .description('import a digest-pinned image as a new version')
    .option('--wait', 'poll until the import finishes instead of returning at 202')
    .option('--timeout <seconds>', 'how long --wait polls before giving up', (v) => parseInt(v, 10), 300)
    .action(
      async (
        name: string,
        image: string,
        opts: { wait?: boolean; timeout: number },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const json = outputMode(flags) === 'json'
        if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
          throw new CliError('--timeout must be a positive number of seconds', ExitCode.Usage)
        }
        // Catch the tag case here rather than as a server 400: it is the
        // single most common mistake, and the reason is worth stating.
        if (!image.includes('@')) {
          throw new CliError(`image "${image}" must be digest-pinned`, ExitCode.Usage, [
            'Use repository@sha256:<digest>, not a tag. A tag can be moved, and a',
            'template version has to always mean the same bytes.',
            'Find the digest with: docker inspect --format=\'{{index .RepoDigests 0}}\' <image>',
          ])
        }

        const api = await apiContext(cmd)
        let version: TemplateVersion
        try {
          version = await api.client.importTemplateVersion(name, image)
        } catch (err) {
          throw mapTemplateError(err, api, name)
        }

        if (!opts.wait) {
          if (json) {
            printJson(version)
            return
          }
          console.log(
            `${accentVerb('Importing')} v${version.version} of "${name}" (${version.status}).`,
          )
          console.error(hintText(`  check progress: orca templates versions ${name}`))
          return
        }

        if (!json) {
          console.error(hintText(`Waiting for v${version.version} of "${name}" to finish importing...`))
        }
        const final = await waitForVersion(api, name, version.version, opts.timeout * 1000)

        if (json) {
          printJson(final)
        } else if (final.status === 'ready') {
          console.log(`${accentVerb('Imported')} v${final.version} of "${name}".`)
          console.error(hintText(`  activate it: orca templates activate ${name} ${final.version}`))
        } else if (final.status === 'failed') {
          console.error(`v${final.version} of "${name}" failed to import.`)
        } else {
          console.error(`v${final.version} of "${name}" is still ${final.status}.`)
        }

        // Exit non-zero on a bad outcome even in --json mode, where the body
        // has already been printed: a script that only checks the exit code
        // must not read a failed import as a success.
        if (final.status === 'failed') {
          throw new CliError(
            final.failureReason ?? `import of v${final.version} failed`,
            ExitCode.Failure,
          )
        }
        if (isInFlight(final.status)) {
          throw new CliError(
            `timed out after ${opts.timeout}s with v${final.version} still ${final.status}`,
            ExitCode.Failure,
            [`It may still finish. Check with: orca templates versions ${name}`],
          )
        }
      },
    )

  templates
    .command('activate <name> <version>')
    .description('point the template at a version (this is also how you roll back)')
    .action(async (name: string, versionArg: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const version = parseInt(versionArg, 10)
      if (!Number.isInteger(version) || version < 1) {
        throw new CliError(`version must be a positive integer, got "${versionArg}"`, ExitCode.Usage)
      }
      const api = await apiContext(cmd)
      let updated: Template
      try {
        updated = await api.client.activateTemplateVersion(name, version)
      } catch (err) {
        // 409 here almost always means "not ready yet", which is a wait, not
        // a mistake. Say so instead of surfacing the bare conflict.
        if (err instanceof ApiError && err.status === 409) {
          throw new CliError(
            extractError(err.body) ?? `v${version} of "${name}" cannot be activated yet`,
            ExitCode.Failure,
            [`Only a ready version can be activated. Check: orca templates versions ${name}`],
          )
        }
        throw mapTemplateError(err, api, name)
      }
      if (outputMode(flags) === 'json') {
        printJson(updated)
        return
      }
      console.log(`${accentVerb('Activated')} v${version} of "${name}".`)
      console.error(
        hintText('  agents tracking this template pick it up on their next session'),
      )
    })
}
