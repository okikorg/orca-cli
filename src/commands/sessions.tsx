import path from 'node:path'

import type { Command } from 'commander'
import type { AgentSession, AgentSessionItem } from 'openai/resources/beta/agents/agents'
import type { SessionArtifact } from 'openai/resources/beta/agents/sessions/artifacts'

import { resolveAgentId } from '../lib/agents.js'
import { toPage } from '../lib/api.js'
import { findArtifact, oneDestination, saveArtifact, saveNewestTurn } from '../lib/artifacts.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatCount, formatTime } from '../lib/format.js'
import { stripControlSequences } from '../lib/markdown.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import {
  addSessionCreateOptions,
  createSession,
  filesFromFlags,
  goingToSleep,
  itemRole,
  itemText,
  requestSleep,
  sandboxStateWords,
  sleepNote,
  sessionUsageRows,
  payerLabel,
  sessionEnvironment,
  sessionView,
  sleepFailure,
  waitForSleep,
  type SessionCreateFlags,
} from '../lib/sessions.js'
import { stagedNote } from '../lib/staging.js'
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

// How long `sessions sleep` waits for the sandbox to be asleep.
const SLEEP_WAIT_MS = 10 * 60 * 1000

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
          ...(session.sandbox ? [['sandbox', session.sandbox]] : []),
          ['created', formatTime(session.created_at)],
          ['lastActive', formatTime(session.last_active_at)],
          ...rows.map((row) => [row.key, row.plain]),
          ['error', session.error ?? '-'],
        ])
        return
      }
      const { Panel, Field } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      // Wide enough for the 12-letter meter labels ("web searches", "machine
      // time") plus a space, so every value in the panel starts in one column.
      const LABEL_WIDTH = 14
      await renderStatic(
        <Panel title={session.id} subtitle={session.agent.id}>
          <Field width={LABEL_WIDTH} label="status" value={session.status} valueColor={sessionStatusColor(session.status, theme)} />
          <Field
            width={LABEL_WIDTH}
            label="model"
            value={session.model === session.agent_model ? session.model : `${session.model} (switched from ${session.agent_model})`}
          />
          <Field width={LABEL_WIDTH} label="pays" value={payerLabel(session.payer)} />
          <Field width={LABEL_WIDTH} label="environment" value={session.environment.type} />
          {session.sandbox ? <Field width={LABEL_WIDTH} label="sandbox" value={sandboxStateWords(session.sandbox)} /> : null}
          <Field width={LABEL_WIDTH} label="created" value={formatTime(session.created_at)} />
          <Field width={LABEL_WIDTH} label="last active" value={formatTime(session.last_active_at)} />
          {rows.map((row) => (
            <Field key={row.key} width={LABEL_WIDTH} label={row.label} value={row.shown} />
          ))}
          {session.vault_ids.length ? <Field width={LABEL_WIDTH} label="vaults" value={session.vault_ids.join(', ')} /> : null}
          {session.error ? <Field width={LABEL_WIDTH} label="error" value={session.error} valueColor={theme.destructive} /> : null}
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
    const files = await filesFromFlags(opts)
    const api = await apiContext(cmd)
    const agentId = await withApi(api, async (c) => resolveAgentId(await c.v1(), opts.agent))
    // Refuses a malformed flag before any file is uploaded.
    sessionEnvironment(opts)
    const session = await withApi(api, async (c) => createSession(await c.v1(), agentId, opts, files))
    if (process.stderr.isTTY) for (const line of stagedNote(files)) console.error(hintText(line))
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

  // Artifacts: the files a session's turns saved under /workspace/outputs.
  const artifacts = sessions
    .command('artifacts <session>')
    .description('list a session\'s artifacts, the files its turns saved under /workspace/outputs, newest first')
  addPageFlags(artifacts)
  artifacts.action(async (sessionId: string, opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, async (c) => toPage(await (await c.v1()).beta.agents.sessions.artifacts.list(sessionId, params))),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No artifacts yet. Files the agent saves under /workspace/outputs are kept when a turn completes.'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(page.items.map((a) => [a.id, a.path, a.size_bytes, a.turn_id, formatTime(a.created_at)]))
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Artifacts"
        meta={[sessionId, pagedSubtitle(page)]}
        headers
        hint={`orca sessions artifacts download ${sessionId} --all`}
        columns={[
          { header: 'id', get: (a: SessionArtifact) => a.id, color: () => theme.accent, bold: true },
          { header: 'path', get: (a: SessionArtifact) => stripControlSequences(a.path) },
          { header: 'size', get: (a: SessionArtifact) => formatCount(a.size_bytes) },
          { header: 'turn', get: (a: SessionArtifact) => a.turn_id },
          { header: 'created', get: (a: SessionArtifact) => formatTime(a.created_at) },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })

  artifacts
    .command('download <session> [artifact]')
    .description('download an artifact (an id, or a path as listed), or with --all the newest turn\'s artifacts')
    .option('-o, --output <path>', 'the file to write, - for stdout; with --all, the folder (default: here, under each file\'s own name)')
    .option('--all', 'every artifact of the newest turn')
    .action(async (sessionId: string, ref: string | undefined, opts: { output?: string; all?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      // `artifacts` lists with page flags of its own, and commander gives an
      // option both commands define to the parent: read --all from either.
      const all = Boolean(opts.all || cmd.parent?.opts().all)
      if (all === (ref !== undefined)) {
        throw new CliError(all ? 'give an artifact or --all, not both' : 'give an artifact, or --all', ExitCode.Usage, [
          `Usage: orca sessions artifacts download ${sessionId} <artifact> [-o path|-]`,
          `   or: orca sessions artifacts download ${sessionId} --all [-o folder]`,
        ])
      }
      if (all && opts.output === '-') throw new CliError('--all writes files to a folder, not stdout', ExitCode.Usage)
      const api = await apiContext(cmd)
      const client = await api.client.v1()
      const saved = all
        ? await withApi(api, () => saveNewestTurn(client, sessionId, opts.output ?? '.'))
        : [
            await withApi(api, async () => {
              const artifact = await findArtifact(client, sessionId, ref as string)
              return saveArtifact(client, artifact, await oneDestination(artifact, opts.output))
            }),
          ]
      if (opts.output === '-') return
      if (outputMode(flags) === 'json') {
        printJson(all ? saved : saved[0])
        return
      }
      for (const file of saved) {
        console.error(`${accentVerb('Saved')} ${file.id} to ${path.relative(process.cwd(), file.path) || file.path}.`)
      }
    })

  // Sleep (sandbox-sleep D6.7): the server saves /workspace and stops the
  // sandbox after it answers, so the command reads the sandbox every second
  // until the sleep ends. Past SLEEP_WAIT_MS it stops waiting; the sleep goes
  // on without it.
  sessions
    .command('sleep <id>')
    .description('put a session\'s sandbox to sleep now; its next message wakes it')
    .option('--no-wait', 'return once the sandbox starts going to sleep')
    // The global --json; listed here so the help says what it prints.
    .option('--json', 'print the session.sandbox object')
    .action(async (id: string, opts: { wait: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const json = outputMode(flags) === 'json'
      const api = await apiContext(cmd)
      let view = await withApi(api, (c) => requestSleep(c, id))
      const started = goingToSleep(view)
      if (started && opts.wait) {
        if (!json) console.error(hintText(`Putting the sandbox of session ${id} to sleep...`))
        view = await withApi(api, (c) => waitForSleep(c, id, view, Date.now() + SLEEP_WAIT_MS))
      }
      if (json) printJson(view)
      const failure = sleepFailure(view)
      if (failure) throw new CliError(failure, ExitCode.Failure)
      if (json) return
      if (goingToSleep(view)) {
        console.log(`The sandbox of session ${id} is going to sleep. Check with: orca sessions get ${id}`)
        return
      }
      if (view.state === 'none') {
        console.log(`Session ${id} has no sandbox to put to sleep.`)
      } else if (view.state === 'asleep' && !started) {
        console.log(`The sandbox of session ${id} is already asleep.`)
      } else if (view.state === 'asleep' || view.last_sleep?.outcome === 'asleep') {
        console.log(
          `${accentVerb('Asleep.')} Session ${id} keeps its conversation and the files in /workspace; machine time has stopped. Its next message wakes it.`,
        )
      } else {
        console.log(`The sandbox of session ${id} is ${sandboxStateWords(view.state)}.`)
        return
      }
      // Why it slept, or what its last sleep found (free-plan F37, A6 (4), (26), (28)).
      const note = sleepNote(view)
      if (note) console.log(note)
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
