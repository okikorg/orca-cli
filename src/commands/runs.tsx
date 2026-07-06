import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import { addUsage, formatDuration, formatEventText, formatTimestamp, formatUsage, runRow } from '../lib/format.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderInk,
  renderStatic,
  type OutputMode,
} from '../lib/output.js'
import { streamRunEvents } from '../lib/sse.js'
import type { RunEvent, RunStatus, RunSummary, Usage } from '../lib/types.js'
import { accentVerb, hintText, paint, statusAnsiCode, statusColor } from '../ui/theme.js'
import {
  addPageFlags,
  apiContext,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type ApiContext,
  type PageFlags,
} from './shared.js'

// tailRun streams a run to the chosen sink and applies the exit-code
// contract: ok -> 0, error/cancelled/interrupted -> 1, local detach -> 130.
// Ctrl-C detaches the tail only; the run keeps going server-side.
async function tailRun(api: ApiContext, runId: string, mode: OutputMode): Promise<void> {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)

  const detached = () =>
    new CliError('detached; the run is still going', ExitCode.Interrupt, [
      `Reattach with: orca runs tail ${runId}`,
      `Stop it with:  orca runs cancel ${runId}`,
    ])

  try {
    let status: RunStatus
    if (mode === 'ink') {
      const { RunTail } = await import('../ui/RunTail.js')
      let final: RunStatus | null = null
      await renderInk(
        <RunTail
          runId={runId}
          subscribe={(onEvent) =>
            withApi(api, (c) => streamRunEvents(c, runId, onEvent, { signal: controller.signal }))
          }
          onDone={(s) => {
            final = s
          }}
        />,
      )
      if (final === null || final === 'running') {
        // Ink exited before the stream finished: the user hit Ctrl-C.
        controller.abort()
        throw detached()
      }
      status = final
    } else {
      const sink =
        mode === 'json'
          ? (e: RunEvent) => process.stdout.write(JSON.stringify(e) + '\n')
          : (e: RunEvent) => {
              const line = formatEventText(e)
              if (line !== null) process.stdout.write(line + '\n')
            }
      status = await withApi(api, (c) => streamRunEvents(c, runId, sink, { signal: controller.signal }))
      if (controller.signal.aborted && status === 'running') throw detached()
      console.error(paint(`run ${runId} finished: ${status}`, statusAnsiCode(status)))
    }
    if (status !== 'ok') {
      throw new CliError(`run finished with status "${status}"`, ExitCode.Failure)
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

export function registerRuns(program: Command): void {
  const runs = program.command('runs').description('inspect and control runs')

  const runsList = runs
    .command('list')
    .description('list recent runs')
    .option('--agent <name>', 'only runs for this agent')
  addPageFlags(runsList)
  runsList.action(async (opts: PageFlags & { agent?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<RunSummary>(opts, (params) =>
        withApi(api, (c) =>
          opts.agent ? c.listProfileRuns(opts.agent, params) : c.listRuns(params),
        ),
      )
      const items = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error(hintText('No runs.'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(items.map(runRow))
        printPageHint(items.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="RUNS" subtitle={pagedSubtitle(items.length, page.total)}>
          <Table
            columns={[
              { header: 'id', get: (r: RunSummary) => r.id, color: () => theme.accent, bold: true },
              { header: 'agent', get: (r: RunSummary) => r.subTask.profile },
              {
                header: 'status',
                get: (r: RunSummary) => r.status,
                color: (r: RunSummary) => statusColor(r.status),
              },
              { header: 'started', get: (r: RunSummary) => formatTimestamp(r.startedAt) },
              {
                header: 'duration',
                get: (r: RunSummary) => (r.finishedAt ? formatDuration(r.startedAt, r.finishedAt) : '-'),
              },
            ]}
            rows={items}
          />
        </Panel>,
      )
      printPageHint(items.length, page.total)
    })

  runs
    .command('get <id>')
    .description('show a finished or running run with its buffered events')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const run = await withApi(api, (c) => c.getRun(id))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(run)
        return
      }

      let usage: Usage = {}
      for (const e of run.events) {
        if (e.type === 'usage') usage = addUsage(usage, e.usage)
      }
      const usageText = formatUsage(usage)

      if (mode === 'plain') {
        console.log(`Run:      ${run.id}`)
        console.log(`Agent:    ${run.subTask.profile}`)
        console.log(`Title:    ${run.subTask.title}`)
        console.log(`Status:   ${run.status}`)
        console.log(`Started:  ${formatTimestamp(run.startedAt)}`)
        if (run.finishedAt) console.log(`Duration: ${formatDuration(run.startedAt, run.finishedAt)}`)
        const lines: string[] = []
        for (const e of run.events) {
          const line = formatEventText(e)
          if (line !== null) lines.push(line)
        }
        if (lines.length > 0) {
          console.log('')
          for (const line of lines) console.log(line)
        }
        if (usageText) console.log(`\nTokens:   ${usageText}`)
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { EventLine } = await import('../ui/RunTail.js')
      const { Box } = await import('ink')
      await renderStatic(
        <Panel title={run.id} subtitle={run.subTask.profile}>
          <Field label="title" value={run.subTask.title} />
          <Field label="status" value={run.status} valueColor={statusColor(run.status)} />
          <Field label="started" value={formatTimestamp(run.startedAt)} />
          {run.finishedAt ? (
            <Field label="duration" value={formatDuration(run.startedAt, run.finishedAt)} />
          ) : null}
          {usageText ? <Field label="tokens" value={usageText} /> : null}
          {run.events.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {run.events.map((e, i) => (
                <Box key={i}>
                  <EventLine event={e} />
                </Box>
              ))}
            </Box>
          ) : null}
        </Panel>,
      )
    })

  runs
    .command('cancel <id>')
    .description('cancel an in-flight run')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      await withApi(api, (c) => c.cancelRun(id))
      if (outputMode(flags) === 'json') printJson({ id, cancelled: true })
      else console.log(`${accentVerb('Cancelled')} run ${id}.`)
    })

  runs
    .command('tail <id>')
    .description('attach to a run stream (replays buffered events, then live)')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      await tailRun(api, id, outputMode(flags))
    })

  program
    .command('run [agent] [prompt...]')
    .description('start a run and stream it (the agent picker opens when omitted)')
    .option('--title <title>', 'run title (defaults to the prompt)')
    .option('--session <id>', 'reuse an existing session')
    .option('--detach', 'print the run id and exit without tailing')
    .action(
      async (
        agent: string | undefined,
        promptParts: string[],
        opts: { title?: string; session?: string; detach?: boolean },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)

        let profile = agent
        if (!profile) {
          if (!interactive()) {
            throw new CliError('agent name required in non-interactive mode', ExitCode.Usage, [
              'Usage: orca run <agent> "prompt"',
            ])
          }
          const page = await withApi(api, (c) => c.listProfiles())
          if (page.items.length === 0) {
            throw new CliError('no agents; create one with: orca agents create -f agent.yaml', ExitCode.Usage)
          }
          const { pickOne } = await import('../ui/AgentPicker.js')
          profile = await pickOne('Select an agent', page.items.map((p) => p.name))
        }

        let prompt = promptParts.join(' ').trim()
        if (!prompt) {
          if (!interactive()) {
            throw new CliError('prompt required in non-interactive mode', ExitCode.Usage, [
              'Usage: orca run <agent> "prompt"',
            ])
          }
          const { promptText } = await import('../ui/PromptInput.js')
          prompt = (await promptText({ label: 'Prompt' })).trim()
          if (!prompt) throw new CliError('empty prompt', ExitCode.Usage)
        }

        const title = opts.title ?? (prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt)
        const created = await withApi(api, (c) =>
          c.createRun({
            profile: profile,
            title,
            prompt,
            ...(opts.session ? { sessionId: opts.session } : {}),
          }),
        )

        if (opts.detach) {
          // stdout carries only the run id so scripts can capture it.
          if (outputMode(flags) === 'json') printJson(created)
          else process.stdout.write(created.runId + '\n')
          console.error(hintText(`started run ${created.runId} (session ${created.sessionId})`))
          return
        }
        console.error(hintText(`run ${created.runId} started (agent "${profile}")`))
        await tailRun(api, created.runId, outputMode(flags))
      },
    )
}
