import type { Command } from 'commander'

import { formatDuration, formatTimestamp } from '../lib/format.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { RunSummary } from '../lib/types.js'
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

// Session mirrors the conductor Session schema (docs/openapi.sdk.yaml, Sessions
// group; runtime/httpapi handleGetSession). Tenant-key accessible via
// /api/sessions and /api/sessions/{id}.
type Session = {
  id: string
  profile: string
  runtime: string
  status: string // idle | running | errored | shutdown
  createdAt: string
  lastUsedAt: string
  lastPrompt?: string
  lastRunStartedAt?: string
  lastRunFinishedAt?: string
  lastRunStatus?: string
  runCount: number
}

// sessionStatusColor tints the status cell: coral for live, destructive for
// errored, subtle for shut-down. Idle keeps the terminal default.
function sessionStatusColor(status: string, theme: { accent: string; destructive: string; subtle: string }): string | undefined {
  switch (status) {
    case 'running':
      return theme.accent
    case 'errored':
      return theme.destructive
    case 'shutdown':
      return theme.subtle
    default:
      return undefined
  }
}

export function registerSessions(program: Command): void {
  const sessions = program.command('sessions').description('inspect persisted agent sessions')

  const sessionsList = sessions
    .command('list')
    .description('list sessions')
    .option('--agent <name>', 'only sessions for this exact profile name')
  addPageFlags(sessionsList)
  sessionsList.action(async (opts: PageFlags & { agent?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      // --agent maps to the server's ?profile= exact-equality filter (not the
      // ?q= id/profile substring match, which would also catch, e.g.,
      // "dev-helper" for "dev"), composed with pagination so the total reflects
      // the filtered set. The client-side filter below is a belt-and-braces
      // guard for servers that predate ?profile= and would ignore it.
      const page = await fetchPageOrAll<Session>(opts, (params) =>
        withApi(api, (c) => c.listSessions<Session>({ ...params, profile: opts.agent })),
      )
      const items = opts.agent ? page.items.filter((s) => s.profile === opts.agent) : page.items

      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error(opts.agent ? `No sessions for agent "${opts.agent}".` : 'No sessions.')
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          items.map((s) => [
            s.id,
            s.profile,
            s.runtime,
            s.status,
            formatTimestamp(s.lastUsedAt),
            s.runCount,
          ]),
        )
        printPageHint(items.length, page.total)
        return
      }

      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="SESSIONS" subtitle={pagedSubtitle(items.length, page.total)}>
          <Table
            columns={[
              { header: 'id', get: (s: Session) => s.id, color: () => theme.accent, bold: true },
              { header: 'profile', get: (s: Session) => s.profile },
              { header: 'runtime', get: (s: Session) => s.runtime },
              {
                header: 'status',
                get: (s: Session) => s.status,
                color: (s: Session) => sessionStatusColor(s.status, theme),
              },
              { header: 'last used', get: (s: Session) => formatTimestamp(s.lastUsedAt) },
              { header: 'runs', get: (s: Session) => String(s.runCount) },
            ]}
            rows={items}
          />
        </Panel>,
      )
      printPageHint(items.length, page.total)
    })

  sessions
    .command('get <id>')
    .description('show one session with its recent runs')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const session = await withApi(api, (c) => c.request<Session>(`/api/sessions/${encodeURIComponent(id)}`))
      // Run history is a second endpoint; degrade to the session's own runCount
      // rather than failing the detail view when it is unavailable.
      let runs: RunSummary[] | null = null
      try {
        runs = (await api.client.listSessionRuns(id)).items
      } catch {
        runs = null
      }

      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson({ ...session, runs: runs ?? [] })
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['id', session.id],
          ['profile', session.profile],
          ['runtime', session.runtime],
          ['status', session.status],
          ['created', formatTimestamp(session.createdAt)],
          ['lastUsed', formatTimestamp(session.lastUsedAt)],
          ['runCount', session.runCount],
          ['lastRunStatus', session.lastRunStatus ?? '-'],
        ])
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { Table } = await import('../ui/Table.js')
      const { Box, Text } = await import('ink')
      const { theme } = await import('../ui/theme.js')
      const recent = (runs ?? []).slice(0, 5)
      await renderStatic(
        <Panel title={session.id} subtitle={session.profile}>
          <Field label="runtime" value={session.runtime} />
          <Field
            label="status"
            value={session.status}
            valueColor={sessionStatusColor(session.status, theme)}
          />
          <Field label="created" value={formatTimestamp(session.createdAt)} />
          <Field label="last used" value={formatTimestamp(session.lastUsedAt)} />
          <Field label="runs" value={String(session.runCount)} />
          {session.lastRunStatus ? (
            <Field label="last run" value={session.lastRunStatus} />
          ) : null}
          {session.lastPrompt ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.subtle}>last prompt</Text>
              <Text color={theme.muted}>{session.lastPrompt}</Text>
            </Box>
          ) : null}
          {recent.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.subtle}>recent runs</Text>
              <Table
                columns={[
                  { header: 'id', get: (r: RunSummary) => r.id, color: () => theme.accent, bold: true },
                  { header: 'status', get: (r: RunSummary) => r.status },
                  { header: 'started', get: (r: RunSummary) => formatTimestamp(r.startedAt) },
                  {
                    header: 'duration',
                    get: (r: RunSummary) => (r.finishedAt ? formatDuration(r.startedAt, r.finishedAt) : '-'),
                  },
                ]}
                rows={recent}
              />
            </Box>
          ) : null}
        </Panel>,
      )
    })
}
