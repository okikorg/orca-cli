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
import { accentVerb, glyphs, hintText, paint, statusAnsiCode, statusColor } from '../ui/theme.js'
import {
  addPageFlags,
  apiContext,
  DEFAULT_PAGE_LIMIT,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type ApiContext,
  type PageFlags,
} from './shared.js'

// pickRun opens the generic Picker over recent runs when an interactive TTY
// invokes `runs get|tail|cancel` without an id. Rows show the run id (label)
// plus a subtle `agent · status · started` detail so the choice carries the
// same context the list view does. Non-interactive callers never reach here
// (the actions throw the usage error first), so no terminal guard is needed
// beyond interactive(); esc/Ctrl-C reject with the interrupt code, matching
// pickOne. Kept out of the unit-tested path (mounts Ink) exactly like pickOne.
async function pickRun(api: ApiContext): Promise<string> {
  const page = await withApi(api, (c) => c.listRuns({ limit: DEFAULT_PAGE_LIMIT }))
  if (page.items.length === 0) {
    throw new CliError('no runs yet; start one with: orca run <agent> "prompt"', ExitCode.Usage)
  }
  const { render } = await import('ink')
  const { Picker } = await import('../ui/Picker.js')
  const items = page.items.map((r) => ({
    label: r.id,
    value: r.id,
    detail: `${r.subTask.profile} ${glyphs.separator} ${r.status} ${glyphs.separator} ${formatTimestamp(r.startedAt)}`,
  }))
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const cancel = () => {
      if (settled) return
      settled = true
      instance.unmount()
      reject(new CliError('cancelled', ExitCode.Interrupt))
    }
    const instance = render(
      <Picker
        items={items}
        placeholder="select a run"
        onSubmit={(value) => {
          if (settled) return
          settled = true
          instance.unmount()
          resolve(value)
        }}
        onCancel={cancel}
      />,
      { exitOnCtrlC: true },
    )
    void instance.waitUntilExit().then(cancel)
  })
}

// resolveRunId supplies the run id for get|tail|cancel: the positional arg when
// present, else the interactive picker. Non-interactive callers with no id get
// the same usage error (exit 2) and message shape as before the picker existed,
// keeping the machine contract identical.
async function resolveRunId(api: ApiContext, verb = 'get'): Promise<string> {
  if (!interactive()) {
    throw new CliError('run id required in non-interactive mode', ExitCode.Usage, [
      `Usage: orca runs ${verb} <id>`,
    ])
  }
  return pickRun(api)
}

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
        // Empty state names the command that creates a run. stderr only, so
        // plain stdout stays empty (byte-identical) for scripts.
        console.error(hintText('No runs yet. Start one with: orca run <agent> "prompt"'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(items.map(runRow))
        printPageHint(items.length, page.total)
        return
      }
      const { Table, statusDot } = await import('../ui/Table.js')
      const { theme } = await import('../ui/theme.js')
      // Header line + UPPERCASE column labels: `runs` is a wide, multi-column
      // table where a labelled header disambiguates the id/agent/status grid.
      // The status cell renders `● <status>` via statusDot, tinted by the run
      // status palette. The hint teaches the two obvious follow-ups.
      await renderStatic(
        <Table
          title="Runs"
          meta={pagedSubtitle(items.length, page.total)}
          headers
          hint="orca runs tail <id> · orca runs get <id>"
          columns={[
            { header: 'id', get: (r: RunSummary) => r.id, color: () => theme.accent, bold: true },
            { header: 'agent', get: (r: RunSummary) => r.subTask.profile },
            {
              header: 'status',
              get: (r: RunSummary) => statusDot(r.status),
              color: (r: RunSummary) => statusColor(r.status),
            },
            { header: 'started', get: (r: RunSummary) => formatTimestamp(r.startedAt) },
            {
              header: 'duration',
              get: (r: RunSummary) => (r.finishedAt ? formatDuration(r.startedAt, r.finishedAt) : '-'),
            },
          ]}
          rows={items}
        />,
      )
      printPageHint(items.length, page.total)
    })

  runs
    .command('get [id]')
    .description('show a finished or running run (the run picker opens when omitted)')
    .action(async (id: string | undefined, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const runId = id ?? (await resolveRunId(api))
      const run = await withApi(api, (c) => c.getRun(runId))
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
    .command('cancel [id]')
    .description('cancel an in-flight run (the run picker opens when omitted)')
    .action(async (id: string | undefined, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const runId = id ?? (await resolveRunId(api, 'cancel'))
      await withApi(api, (c) => c.cancelRun(runId))
      if (outputMode(flags) === 'json') printJson({ id: runId, cancelled: true })
      else console.log(`${accentVerb('Cancelled')} run ${runId}.`)
    })

  runs
    .command('tail [id]')
    .description('attach to a run stream (the run picker opens when omitted)')
    .action(async (id: string | undefined, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const runId = id ?? (await resolveRunId(api, 'tail'))
      await tailRun(api, runId, outputMode(flags))
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
