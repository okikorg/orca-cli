import type { Command } from 'commander'

import { loadProfileFile } from '../lib/profile-file.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTimestamp } from '../lib/format.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderStatic,
} from '../lib/output.js'
import type { AgentProfile } from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm, revealIssuedKey } from './prompts.js'
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

// ProfileChange mirrors the audit row surfaced by GET
// /api/profiles/{name}/changes (profileChangeDTO). before/after are the
// redacted profile snapshots; the table view only needs when/action/fields/id.
type ProfileChange = {
  id: string
  profile: string
  action: string
  at: string
  fields?: string[]
  before?: AgentProfile
  after?: AgentProfile
}

function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.error(hintText(`warning: ${w}`))
}

// AgentDetail renders one profile as a coral-titled panel of label/value
// fields, plus the system prompt if present.
async function renderAgentDetail(p: AgentProfile): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { Box, Text } = await import('ink')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title={p.name} subtitle={p.runtime}>
      {p.model ? <Field label="model" value={p.model} /> : null}
      {p.skills?.length ? <Field label="skills" value={p.skills.join(', ')} /> : null}
      {p.tools?.length ? <Field label="tools" value={p.tools.join(', ')} /> : null}
      {p.mcpServers?.length ? (
        <Field label="mcp" value={p.mcpServers.map((s) => `${s.name} (${s.transport})`).join(', ')} />
      ) : null}
      {p.sandbox ? (
        <Field label="sandbox" value={`${p.sandbox.provider}${p.sandbox.template ? ` / ${p.sandbox.template}` : ''}`} />
      ) : null}
      {p.systemPrompt ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.subtle}>system prompt</Text>
          <Text color={theme.muted}>{p.systemPrompt}</Text>
        </Box>
      ) : null}
    </Panel>,
  )
}

export function registerAgents(program: Command): void {
  const agents = program.command('agents').description('manage agent profiles')

  const agentsList = agents.command('list').description('list agents')
  addPageFlags(agentsList)
  agentsList.action(async (opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll(opts, (params) =>
        withApi(api, (c) => c.listProfiles(params)),
      )
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(page.items)
        return
      }

      // Published state comes from a second endpoint; degrade to '?' rather
      // than failing the whole listing when it is unavailable. Page through the
      // full set (the server caps a single request at 200) so agents past the
      // first page still get an accurate badge.
      let published: Set<string> | null = null
      try {
        const pub = await fetchAll((params) => api.client.listPublishedAgents(params))
        published = new Set(pub.items.map((p) => p.profileName))
      } catch {
        console.error(hintText('warning: could not load published state'))
      }
      const pubCell = (p: AgentProfile) =>
        published === null ? '?' : published.has(p.name) ? 'yes' : 'no'

      if (page.items.length === 0) {
        console.error(hintText('No agents. Create one with: orca agents create -f agent.yaml'))
        return
      }

      if (mode === 'plain') {
        printPlainRows(page.items.map((p) => [p.name, p.runtime, p.model ?? '-', pubCell(p)]))
        printPageHint(page.items.length, page.total)
        return
      }

      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="AGENTS" subtitle={pagedSubtitle(page.items.length, page.total)}>
          <Table
            columns={[
              { header: 'name', get: (p: AgentProfile) => p.name, color: () => theme.accent, bold: true },
              { header: 'runtime', get: (p: AgentProfile) => p.runtime },
              { header: 'model', get: (p: AgentProfile) => p.model ?? '-' },
              {
                header: 'published',
                get: pubCell,
                color: (p: AgentProfile) => (pubCell(p) === 'yes' ? theme.accent : theme.subtle),
              },
            ]}
            rows={page.items}
          />
        </Panel>,
      )
      printPageHint(page.items.length, page.total)
    })

  agents
    .command('get <name>')
    .description('show one agent')
    .action(async (name: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const profile = await withApi(api, (c) => c.getProfile(name))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(profile)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['name', profile.name],
          ['runtime', profile.runtime],
          ['model', profile.model ?? '-'],
          ['skills', profile.skills?.join(',') ?? '-'],
        ])
        return
      }
      await renderAgentDetail(profile)
    })

  agents
    .command('changes <name>')
    .description('show the change history for an agent profile')
    .option('--limit <n>', 'cap the number of entries shown', (v) => parseInt(v, 10))
    .action(async (name: string, opts: { limit?: number }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      // GET /api/profiles/{name}/changes returns a raw array (audit-backed in
      // DB mode, in-memory ring otherwise): profileChangeDTO in
      // agent-runtime/runtime/httpapi/profile_changes.go :27. The endpoint has
      // no server-side limit param (returns up to 200), so cap client-side.
      let changes = await withApi(api, (c) =>
        c.request<ProfileChange[]>(`/api/profiles/${encodeURIComponent(name)}/changes`),
      )
      if (opts.limit != null) {
        if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
          throw new CliError('--limit must be a positive number', ExitCode.Usage)
        }
        changes = changes.slice(0, opts.limit)
      }
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(changes)
        return
      }
      if (changes.length === 0) {
        console.error(hintText(`No change history for "${name}".`))
        return
      }
      const fieldsOf = (c: ProfileChange) => (c.fields?.length ? c.fields.join(', ') : '-')
      if (mode === 'plain') {
        printPlainRows(changes.map((c) => [formatTimestamp(c.at), c.action, fieldsOf(c), c.id]))
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      const actionColor = (c: ProfileChange) =>
        c.action === 'deleted' ? theme.destructive : c.action === 'created' ? theme.accent : undefined
      await renderStatic(
        <Panel title="CHANGES" subtitle={name}>
          <Table
            columns={[
              { header: 'when', get: (c: ProfileChange) => formatTimestamp(c.at), color: () => theme.subtle },
              { header: 'action', get: (c: ProfileChange) => c.action, color: actionColor },
              { header: 'fields', get: fieldsOf },
              { header: 'id', get: (c: ProfileChange) => c.id, color: () => theme.subtle },
            ]}
            rows={changes}
          />
        </Panel>,
      )
    })

  agents
    .command('create')
    .description('create an agent from a YAML or JSON file')
    .requiredOption('-f, --file <path>', 'agent document (use - for stdin)')
    .option('--strict', 'treat schema warnings as errors')
    .action(async (opts: { file: string; strict?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const { profile, warnings } = await loadProfileFile(opts.file, { strict: opts.strict })
      printWarnings(warnings)
      const created = await withApi(api, (c) => c.createProfile(profile))
      if (outputMode(flags) === 'json') printJson(created)
      else console.log(`${accentVerb('Created')} agent "${created.name}" (${created.runtime}).`)
    })

  agents
    .command('update [name]')
    .description('update an agent from a YAML or JSON file (rename by targeting the old name)')
    .requiredOption('-f, --file <path>', 'agent document (use - for stdin)')
    .option('--strict', 'treat schema warnings as errors')
    .action(async (name: string | undefined, opts: { file: string; strict?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const { profile, warnings } = await loadProfileFile(opts.file, { strict: opts.strict })
      printWarnings(warnings)
      const target = name ?? profile.name
      if (name && name !== profile.name) {
        console.error(hintText(`renaming "${name}" -> "${profile.name}"`))
      }
      const updated = await withApi(api, (c) => c.updateProfile(target, profile))
      if (outputMode(flags) === 'json') printJson(updated)
      else console.log(`${accentVerb('Updated')} agent "${updated.name}".`)
    })

  agents
    .command('delete <name>')
    .description('delete an agent')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete agent "${name}"?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.deleteProfile(name))
      if (outputMode(flags) === 'json') printJson({ name, deleted: true })
      else console.log(`${accentVerb('Deleted')} agent "${name}".`)
    })

  agents
    .command('publish <name>')
    .description('publish an agent to the public chat gateway')
    .option('--slug <slug>', 'public slug (defaults to a server-generated one)')
    .option('--visibility <visibility>', 'private | org | public')
    .option('--expose-tool-events', 'include tool frames in the public stream')
    .action(
      async (
        name: string,
        opts: { slug?: string; visibility?: string; exposeToolEvents?: boolean },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        if (opts.visibility && !['private', 'org', 'public'].includes(opts.visibility)) {
          throw new CliError('--visibility must be private, org, or public', ExitCode.Usage)
        }
        const published = await withApi(api, (c) =>
          c.publishAgent(name, {
            ...(opts.slug ? { slug: opts.slug } : {}),
            ...(opts.visibility
              ? { visibility: opts.visibility as 'private' | 'org' | 'public' }
              : {}),
            ...(opts.exposeToolEvents ? { exposeToolEvents: true } : {}),
          }),
        )
        if (outputMode(flags) === 'json') {
          printJson(published)
          return
        }
        console.log(`${accentVerb('Published')} "${name}" -> ${published.publicUrl}`)
        console.error(hintText(`Issue a chat key with: orca agents keys create ${name}`))
      },
    )

  agents
    .command('unpublish <name>')
    .description('take a published agent off the public gateway')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to unpublish without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Unpublish "${name}"? Live clients will start failing.`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.unpublishAgent(name))
      if (outputMode(flags) === 'json') printJson({ name, published: false })
      else console.log(`${accentVerb('Unpublished')} "${name}".`)
    })

  const keys = agents.command('keys').description('manage chat keys for a published agent')

  const keysList = keys.command('list <agent>').description('list chat keys')
  addPageFlags(keysList)
  keysList.action(async (agent: string, opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll(opts, (params) =>
        withApi(api, (c) => c.listAgentKeys(agent, params)),
      )
      const items = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error(
          hintText(`No chat keys for "${agent}". Create one with: orca agents keys create ${agent}`),
        )
        return
      }
      const state = (k: (typeof items)[number]) =>
        k.revokedAt ? 'revoked' : k.expiresAt ? `expires ${k.expiresAt}` : 'active'
      if (mode === 'plain') {
        printPlainRows(items.map((k) => [k.id, k.label || '-', k.createdAt, k.lastUsedAt ?? '-', state(k)]))
        printPageHint(items.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="CHAT KEYS" subtitle={agent}>
          <Table
            columns={[
              { header: 'id', get: (k: (typeof items)[number]) => k.id, color: () => theme.accent, bold: true },
              { header: 'label', get: (k: (typeof items)[number]) => k.label || '-' },
              { header: 'created', get: (k: (typeof items)[number]) => k.createdAt },
              { header: 'last used', get: (k: (typeof items)[number]) => k.lastUsedAt ?? '-' },
              {
                header: 'state',
                get: state,
                color: (k: (typeof items)[number]) => (k.revokedAt ? theme.subtle : undefined),
              },
            ]}
            rows={items}
          />
        </Panel>,
      )
      printPageHint(items.length, page.total)
    })

  keys
    .command('create <agent>')
    .description('issue a chat key (the token is shown once)')
    .option('--label <label>', 'key label')
    .action(async (agent: string, opts: { label?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const issued = await withApi(api, (c) => c.issueAgentKey(agent, { label: opts.label }))
      await revealIssuedKey(issued, `Chat key for "${agent}"`, outputMode(flags) === 'json')
    })

  keys
    .command('revoke <agent> <id>')
    .description('revoke a chat key')
    .action(async (agent: string, id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      await withApi(api, (c) => c.revokeAgentKey(agent, id))
      if (outputMode(flags) === 'json') printJson({ agent, id, revoked: true })
      else console.log(`${accentVerb('Revoked')} chat key ${id} for "${agent}".`)
    })
}
