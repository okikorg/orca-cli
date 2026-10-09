import type { Command } from 'commander'
import type { AgentSession, AgentSessionItem } from 'openai/resources/beta/agents/agents'

import { resolveAgentId } from '../lib/agents.js'
import { toPage } from '../lib/api.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import {
  addSessionCreateOptions,
  itemRole,
  itemText,
  sessionCreateParams,
  sessionUsageRows,
  payerLabel,
  sessionView,
  type SessionCreateFlags,
} from '../lib/sessions.js'
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

// sessionStatusColor tints the status cell: mint while a turn runs,
// destructive for failed, subtle while waiting on an action. Idle keeps the
// terminal default.
function sessionStatusColor(
  status: AgentSession['status'],
  theme: { accent: string; destructive: string; subtle: string },
): string | undefined {
  switch (status) {
    case 'in_progress':
      return theme.accent
    case 'failed':
      return theme.destructive
    case 'requires_action':
      return theme.subtle
    case 'idle':
      return undefined
  }
}

export function registerSessions(program: Command): void {
  const sessions = program.command('sessions').description('manage agent sessions (conversations)')

  const sessionsList = sessions
    .command('list')
    .description('list sessions, newest first')
    .option('--agent <agent>', 'only sessions of this agent (id or name)')
  addPageFlags(sessionsList)
  sessionsList.action(async (opts: PageFlags & { agent?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const agentId = opts.agent
      ? await withApi(api, async (c) => resolveAgentId(await c.v1(), opts.agent as string))
      : undefined
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, async (c) =>
        toPage(await (await c.v1()).beta.agents.sessions.list({ ...params, ...(agentId ? { agent_id: agentId } : {}) })),
      ),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No sessions yet. Start one with: orca chat <agent> "prompt"'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(
        page.items.map((s) => [s.id, s.agent.id, s.status, s.environment.type, formatTime(s.last_active_at)]),
      )
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { glyphs, theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Sessions"
        meta={pagedSubtitle(page)}
        headers
        hint="orca sessions get <id> · orca chat <agent> --session <id>"
        columns={[
          { header: 'id', get: (s: AgentSession) => s.id, color: () => theme.accent, bold: true },
          { header: 'agent', get: (s: AgentSession) => s.agent.id },
          {
            header: 'status',
            get: (s: AgentSession) => `${glyphs.statusFilled} ${s.status}`,
            color: (s: AgentSession) => sessionStatusColor(s.status, theme),
          },
          { header: 'environment', get: (s: AgentSession) => s.environment.type },
          { header: 'last active', get: (s: AgentSession) => formatTime(s.last_active_at) },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })

  sessions
    .command('get <id>')
    .description('show one session')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const session = await withApi(api, (c) => sessionView(c, id))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(session)
        return
      }
      const rows = sessionUsageRows(session.usage)
      if (mode === 'plain') {
        printPlainRows([
          ['id', session.id],
          ['agent', session.agent.id],
          ['model', session.model],
          ['agent_model', session.agent_model],
          ['payer', session.payer ?? '-'],
          ['status', session.status],
          ['environment', session.environment.type],
          ['created', formatTime(session.created_at)],
          ['lastActive', formatTime(session.last_active_at)],
          ...rows.map((row) => [row.key, row.plain]),
          ['error', session.error ?? '-'],
        ])
        return
      }
      const { Panel, Field } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title={session.id} subtitle={session.agent.id}>
          <Field label="status" value={session.status} valueColor={sessionStatusColor(session.status, theme)} />
          <Field
            label="model"
            value={session.model === session.agent_model ? session.model : `${session.model} (switched from ${session.agent_model})`}
          />
          <Field label="pays" value={payerLabel(session.payer)} />
          <Field label="environment" value={session.environment.type} />
          <Field label="created" value={formatTime(session.created_at)} />
          <Field label="last active" value={formatTime(session.last_active_at)} />
          {rows.map((row) => (
            <Field key={row.key} label={row.label} value={row.shown} />
          ))}
          {session.vault_ids.length ? <Field label="vaults" value={session.vault_ids.join(', ')} /> : null}
          {session.error ? <Field label="error" value={session.error} valueColor={theme.destructive} /> : null}
        </Panel>,
      )
    })

  addSessionCreateOptions(
    sessions
      .command('create')
      .description('create a session of an agent; talk to it with orca chat <agent> --session <id>')
      .requiredOption('--agent <agent>', 'the agent (id or name)'),
  ).action(async (opts: SessionCreateFlags & { agent: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const api = await apiContext(cmd)
    const agentId = await withApi(api, async (c) => resolveAgentId(await c.v1(), opts.agent))
    const params = sessionCreateParams(agentId, opts)
    const session = await withApi(api, async (c) => (await c.v1()).beta.agents.sessions.create(params))
    if (outputMode(flags) === 'json') {
      printJson(session)
      return
    }
    if (!process.stdout.isTTY) {
      process.stdout.write(session.id + '\n')
      return
    }
    console.log(`${accentVerb('Created')} session ${session.id}.`)
    console.error(hintText(`Talk to it: orca chat ${opts.agent} --session ${session.id}`))
  })

  sessions
    .command('items <id>')
    .description('show the latest conversation items of a session, oldest first')
    .option('--limit <n>', 'how many items (1 to 100)', (v) => parseInt(v, 10), 20)
    .action(async (id: string, opts: { limit: number }, cmd: Command) => {
      const flags = globalFlags(cmd)
      if (!Number.isFinite(opts.limit) || opts.limit < 1 || opts.limit > 100) {
        throw new CliError('--limit must be an integer from 1 to 100', ExitCode.Usage)
      }
      const api = await apiContext(cmd)
      const page = await withApi(api, async (c) =>
        (await c.v1()).beta.agents.sessions.items.list(id, { limit: opts.limit, order: 'desc' }),
      )
      const items = [...page.data].reverse()
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error(hintText('No items in this session yet.'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(items.map((item) => [itemRole(item), itemText(item)]))
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Table
          title="Items"
          meta={[id, `${items.length} shown`]}
          headers
          columns={[
            {
              header: 'role',
              get: itemRole,
              color: (item: AgentSessionItem) => (itemRole(item) === 'assistant' ? theme.accent : theme.subtle),
            },
            { header: 'text', get: itemText },
          ]}
          rows={items}
        />,
      )
    })

  sessions
    .command('delete <id>')
    .description('delete a session and its history')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete session ${id}?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, async (c) => (await c.v1()).beta.agents.sessions.delete(id))
      if (outputMode(flags) === 'json') printJson({ id, deleted: true })
      else console.log(`${accentVerb('Deleted')} session ${id}.`)
    })
}
