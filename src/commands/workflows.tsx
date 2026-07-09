import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import { formatDuration, formatTimestamp } from '../lib/format.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderInk,
  renderStatic,
  type OutputMode,
} from '../lib/output.js'
import {
  cancelWorkflowRun,
  createWorkflowRun,
  deleteWorkflowDefinition,
  deleteWorkflowSchedule,
  diffTransitions,
  formatTransitionText,
  getWorkflowDefinition,
  getWorkflowRun,
  getWorkflowSchedule,
  isTerminalStatus,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowSchedules,
  nodeName,
  orderNodes,
  pauseWorkflowSchedule,
  repairWorkflowRun,
  resumeWorkflowSchedule,
  startWorkflowRun,
  streamWorkflowRun,
  wfNodeStatusLabel,
  wfStatusLabel,
  type RepairAction,
  type WfNodeStatus,
  type WfStatus,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowSchedule,
} from '../lib/workflows.js'
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

// A run id is minted as "workflow-<hex>"; a definition id is "wfdef-<short>".
// `start` accepts either, so it keys off this prefix to pick create-vs-resume.
const RUN_ID_PREFIX = 'workflow-'

function runDuration(run: WorkflowRun): string {
  return run.startedAt ? formatDuration(run.startedAt, run.finishedAt) : '-'
}

function definitionRow(def: WorkflowDefinition): (string | undefined)[] {
  return [def.name, def.id, String(def.nodes?.length ?? 0), formatTimestamp(def.updatedAt)]
}

function runRow(run: WorkflowRun): (string | undefined)[] {
  return [
    run.id,
    wfStatusLabel(run.status),
    String(run.nodes?.length ?? 0),
    formatTimestamp(run.createdAt),
    runDuration(run),
  ]
}

function scheduleRow(s: WorkflowSchedule): (string | undefined)[] {
  return [
    s.id,
    s.workflowDefinitionId,
    s.cron,
    s.timezone ?? '',
    s.status,
    s.lastRunAt ? formatTimestamp(s.lastRunAt) : '-',
  ]
}

// tailWorkflow streams a run to the chosen sink and applies the exit-code
// contract: completed -> 0, failed/cancelled -> 1, local detach -> 130.
// Ctrl-C detaches the tail only; the run keeps going server-side.
async function tailWorkflow(api: ApiContext, runId: string, mode: OutputMode): Promise<void> {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)

  const detached = () =>
    new CliError('detached; the workflow run is still going', ExitCode.Interrupt, [
      `Reattach with: orca workflows tail ${runId}`,
      `Stop it with:  orca workflows cancel ${runId}`,
    ])

  try {
    let status: WfStatus
    if (mode === 'ink') {
      const { WorkflowTail } = await import('../ui/WorkflowTail.js')
      let final: WfStatus | null = null
      await renderInk(
        <WorkflowTail
          runId={runId}
          subscribe={(onFrame) =>
            withApi(api, (c) => streamWorkflowRun(c, runId, onFrame, { signal: controller.signal }))
          }
          onDone={(s) => {
            final = s
          }}
        />,
      )
      if (final === null || !isTerminalStatus(final)) {
        // Ink exited before the stream reached a terminal status: Ctrl-C.
        controller.abort()
        throw detached()
      }
      status = final
    } else {
      const prev = new Map<string, WfNodeStatus>()
      const sink =
        mode === 'json'
          ? (frame: { type: string; workflowRun: WorkflowRun }) =>
              process.stdout.write(JSON.stringify(frame) + '\n')
          : (frame: { type: string; workflowRun: WorkflowRun }) => {
              for (const t of diffTransitions(prev, frame.workflowRun)) {
                process.stdout.write(formatTransitionText(t) + '\n')
              }
            }
      status = await withApi(api, (c) => streamWorkflowRun(c, runId, sink, { signal: controller.signal }))
      if (controller.signal.aborted && !isTerminalStatus(status)) throw detached()
      console.error(`workflow ${runId} finished: ${wfStatusLabel(status)}`)
    }
    if (status !== 3) {
      throw new CliError(`workflow run finished with status "${wfStatusLabel(status)}"`, ExitCode.Failure)
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

// confirmDestructive mounts the shared Confirm component for a y/N gate in
// interactive TTY mode (single keypress; Enter declines). Local per command
// because the shared prompts module belongs to another wave; the mount pattern
// mirrors pickOne/promptText.
async function confirmDestructive(message: string): Promise<boolean> {
  const { render } = await import('ink')
  const { Confirm } = await import('../ui/Confirm.js')
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      instance.unmount()
      resolve(v)
    }
    const instance = render(<Confirm message={message} onDecision={finish} />, { exitOnCtrlC: true })
    void instance.waitUntilExit().then(() => finish(false))
  })
}

// guardDestructive enforces the same --yes / interactive-confirm contract the
// other mutating commands use, returning false when the user aborts. Non-TTY
// callers require --yes and hit the Usage error, so the machine contract is
// unchanged.
async function guardDestructive(
  yes: boolean | undefined,
  verb: string,
  question: string,
): Promise<boolean> {
  if (yes) return true
  if (!interactive()) {
    throw new CliError(`refusing to ${verb} without --yes in non-interactive mode`, ExitCode.Usage)
  }
  const { hintText } = await import('../ui/theme.js')
  if (!(await confirmDestructive(question))) {
    console.error(hintText('Aborted.'))
    return false
  }
  return true
}

export function registerWorkflows(program: Command): void {
  const wf = program.command('workflows').description('view and control workflows')

  // -- Definitions ------------------------------------------------------------

  const wfList = wf.command('list').description('list workflow definitions')
  addPageFlags(wfList)
  wfList.action(async (opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<WorkflowDefinition>(opts, (params) =>
        withApi(api, (c) => listWorkflowDefinitions(c, params)),
      )
      const items = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error('No workflow definitions.')
        return
      }
      if (mode === 'plain') {
        printPlainRows(items.map(definitionRow))
        printPageHint(items.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme, glyphs } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="WORKFLOW DEFINITIONS" subtitle={pagedSubtitle(items.length, page.total)}>
          <Table
            columns={[
              { header: 'name', get: (d: WorkflowDefinition) => d.name, color: () => theme.accent, bold: true },
              { header: 'id', get: (d: WorkflowDefinition) => d.id },
              { header: 'steps', get: (d: WorkflowDefinition) => String(d.nodes?.length ?? 0) },
              { header: 'updated', get: (d: WorkflowDefinition) => formatTimestamp(d.updatedAt) },
            ]}
            rows={items}
            hint={`orca workflows get <id> ${glyphs.separator} orca workflows start <id>`}
          />
        </Panel>,
      )
      printPageHint(items.length, page.total)
    })

  wf.command('get <id>')
    .description('show a workflow definition and its steps')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const def = await withApi(api, (c) => getWorkflowDefinition(c, id))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(def)
        return
      }
      const nodes = def.nodes ?? []
      if (mode === 'plain') {
        printPlainRows(
          orderNodes(nodes).map(({ node }) => [
            nodeName(node),
            node.profile,
            (node.dependsOn ?? []).join(','),
          ]),
        )
        return
      }
      const { Panel, Field } = await import('../ui/Panel.js')
      const { StepTree } = await import('../ui/WorkflowTail.js')
      const { Box, Text } = await import('ink')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title={def.name} subtitle={def.id}>
          {def.description ? <Field label="desc" value={def.description} /> : null}
          {def.userPrompt ? <Field label="prompt" value={def.userPrompt} /> : null}
          <Field label="steps" value={String(nodes.length)} />
          <Field label="updated" value={formatTimestamp(def.updatedAt)} />
          <Box marginTop={1}>
            <Text color={theme.accent} bold>
              STEPS
            </Text>
            <Text color={theme.subtle}>{`  ${nodes.length}`}</Text>
          </Box>
          <StepTree nodes={nodes} />
        </Panel>,
      )
    })

  wf.command('delete <id>')
    .description('delete a workflow definition')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!(await guardDestructive(opts.yes, 'delete', `Delete workflow definition "${id}"?`))) return
      await withApi(api, (c) => deleteWorkflowDefinition(c, id))
      if (outputMode(flags) === 'json') printJson({ id, deleted: true })
      else {
        const { accentVerb } = await import('../ui/theme.js')
        console.log(`${accentVerb('Deleted')} workflow definition "${id}".`)
      }
    })

  // -- Runs -------------------------------------------------------------------

  const runs = wf
    .command('runs')
    .description('list workflow runs')
    .option('--status <status>', 'filter by status (pending|running|paused|completed|failed|cancelled)')
    .option('--orchestrator <runId>', 'only runs spawned by this orchestrator run')
  addPageFlags(runs)
  runs.action(
      async (
        opts: PageFlags & { status?: string; orchestrator?: string },
        cmd: Command,
      ) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<WorkflowRun>(opts, (params) =>
        withApi(api, (c) =>
          listWorkflowRuns(c, {
            status: opts.status,
            limit: params.limit,
            offset: params.offset,
            orchestratorRunId: opts.orchestrator,
          }),
        ),
      )
      const items = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error('No workflow runs.')
        return
      }
      if (mode === 'plain') {
        printPlainRows(items.map(runRow))
        printPageHint(items.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme, glyphs } = await import('../ui/theme.js')
      const { wfStatusColor } = await import('../lib/workflows.js')
      await renderStatic(
        <Panel title="WORKFLOW RUNS" subtitle={pagedSubtitle(items.length, page.total)}>
          <Table
            columns={[
              { header: 'id', get: (r: WorkflowRun) => r.id, color: () => theme.accent, bold: true },
              {
                header: 'status',
                get: (r: WorkflowRun) => wfStatusLabel(r.status),
                color: (r: WorkflowRun) => wfStatusColor(r.status),
              },
              { header: 'steps', get: (r: WorkflowRun) => String(r.nodes?.length ?? 0) },
              { header: 'created', get: (r: WorkflowRun) => formatTimestamp(r.createdAt) },
              { header: 'duration', get: (r: WorkflowRun) => runDuration(r) },
            ]}
            rows={items}
            hint={`orca workflows tail <run-id> ${glyphs.separator} orca workflows runs get <run-id>`}
          />
        </Panel>,
      )
      printPageHint(items.length, page.total)
    })

  runs
    .command('get <id>')
    .description('show a workflow run with per-step status')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const run = await withApi(api, (c) => getWorkflowRun(c, id))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(run)
        return
      }
      const nodes = run.nodes ?? []
      if (mode === 'plain') {
        printPlainRows(
          orderNodes(nodes).map(({ node }) => [
            nodeName(node),
            node.profile,
            wfNodeStatusLabel(node.status),
            String(node.attempt ?? 0),
            node.startedAt ? formatDuration(node.startedAt, node.finishedAt) : '-',
          ]),
        )
        return
      }
      const { Panel, Field } = await import('../ui/Panel.js')
      const { StepTree } = await import('../ui/WorkflowTail.js')
      const { Box, Text } = await import('ink')
      const { theme } = await import('../ui/theme.js')
      const { wfStatusColor } = await import('../lib/workflows.js')
      await renderStatic(
        <Panel title={run.id} subtitle={wfStatusLabel(run.status)}>
          {run.userPrompt ? <Field label="prompt" value={run.userPrompt} /> : null}
          <Field label="status" value={wfStatusLabel(run.status)} valueColor={wfStatusColor(run.status)} />
          <Field label="created" value={formatTimestamp(run.createdAt)} />
          {run.startedAt ? <Field label="started" value={formatTimestamp(run.startedAt)} /> : null}
          {run.finishedAt ? <Field label="duration" value={runDuration(run)} /> : null}
          {run.repairCount > 0 ? <Field label="repairs" value={String(run.repairCount)} /> : null}
          <Box marginTop={1}>
            <Text color={theme.accent} bold>
              STEPS
            </Text>
            <Text color={theme.subtle}>{`  ${nodes.length}`}</Text>
          </Box>
          <StepTree nodes={nodes} showStatus />
        </Panel>,
      )
    })

  wf.command('start <id>')
    .description('start a run: pass a definition id to launch one, or a run id to hand a pending run to the engine')
    .option('--prompt <text>', 'user prompt when launching a definition (overrides its default)')
    .option('--no-autostart', 'create the run pending instead of handing it straight to the engine')
    .action(
      async (id: string, opts: { prompt?: string; autostart?: boolean }, cmd: Command) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        const json = outputMode(flags) === 'json'

        if (id.startsWith(RUN_ID_PREFIX)) {
          // Existing run: hand it to the engine (no-op if already past pending).
          const res = await withApi(api, (c) => startWorkflowRun(c, id))
          if (json) {
            printJson(res)
            return
          }
          process.stdout.write(res.workflowRunId + '\n')
          console.error(`handed workflow ${res.workflowRunId} to the engine${res.status ? ` (status ${res.status})` : ''}`)
          return
        }

        // Definition: instantiate a run from its nodes + prompt.
        const def = await withApi(api, (c) => getWorkflowDefinition(c, id))
        const userPrompt = (opts.prompt ?? def.userPrompt ?? '').trim()
        if (!userPrompt) {
          throw new CliError(`definition "${id}" has no userPrompt`, ExitCode.Usage, [
            'Pass one with: orca workflows start ' + id + ' --prompt "..."',
          ])
        }
        if (!def.nodes || def.nodes.length === 0) {
          throw new CliError(`definition "${id}" has no steps`, ExitCode.Usage)
        }
        const res = await withApi(api, (c) =>
          createWorkflowRun(c, { userPrompt, nodes: def.nodes, autoStart: opts.autostart !== false }),
        )
        if (json) {
          printJson(res)
          return
        }
        process.stdout.write(res.workflowRunId + '\n')
        console.error(
          `started workflow ${res.workflowRunId} from "${id}"${res.status ? ` (status ${res.status})` : ''}`,
        )
        if (opts.autostart === false) {
          console.error(`hand it to the engine with: orca workflows start ${res.workflowRunId}`)
        } else {
          console.error(`follow it with: orca workflows tail ${res.workflowRunId}`)
        }
      },
    )

  wf.command('tail <run-id>')
    .description('stream a workflow run until it reaches a terminal status')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      await tailWorkflow(api, id, outputMode(flags))
    })

  wf.command('cancel <run-id>')
    .description('cancel an in-flight workflow run')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!(await guardDestructive(opts.yes, 'cancel', `Cancel workflow run "${id}"?`))) return
      const res = await withApi(api, (c) => cancelWorkflowRun(c, id))
      if (outputMode(flags) === 'json') printJson(res)
      else {
        const { accentVerb } = await import('../ui/theme.js')
        console.log(`${accentVerb('Cancelled')} workflow run "${id}".`)
      }
    })

  wf.command('repair <run-id>')
    .description('repair a paused workflow run (abort it, or retry a failed step)')
    .option('--type <type>', 'abort | retry-node')
    .option('--node <id>', 'node id to retry (required for retry-node)')
    .action(async (id: string, opts: { type?: string; node?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const type = opts.type
      let action: RepairAction
      if (type === 'abort') {
        action = { type: 'abort' }
      } else if (type === 'retry-node' || type === 'retry_node') {
        if (!opts.node) {
          throw new CliError('retry-node needs a node id: --node <id>', ExitCode.Usage)
        }
        action = { type: 'retry_node', nodeId: opts.node }
      } else {
        throw new CliError('--type must be one of: abort, retry-node', ExitCode.Usage, [
          'replace_node and add_dependency need a full node body; use the API directly for those.',
        ])
      }
      const res = await withApi(api, (c) => repairWorkflowRun(c, id, action))
      if (outputMode(flags) === 'json') printJson(res)
      else {
        const { accentVerb } = await import('../ui/theme.js')
        console.log(`${accentVerb('Repaired')} workflow run "${id}" (${action.type}).`)
      }
    })

  // -- Schedules --------------------------------------------------------------

  const schedules = wf.command('schedules').description('list workflow schedules')
  addPageFlags(schedules)
  schedules.action(async (opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<WorkflowSchedule>(opts, (params) =>
        withApi(api, (c) => listWorkflowSchedules(c, params)),
      )
      const items = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error('No workflow schedules.')
        return
      }
      if (mode === 'plain') {
        printPlainRows(items.map(scheduleRow))
        printPageHint(items.length, page.total)
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme, glyphs } = await import('../ui/theme.js')
      const { scheduleStateColor } = await import('../lib/workflows.js')
      await renderStatic(
        <Panel title="WORKFLOW SCHEDULES" subtitle={pagedSubtitle(items.length, page.total)}>
          <Table
            columns={[
              { header: 'id', get: (s: WorkflowSchedule) => s.id, color: () => theme.accent, bold: true },
              { header: 'definition', get: (s: WorkflowSchedule) => s.workflowDefinitionId },
              { header: 'cron', get: (s: WorkflowSchedule) => s.cron },
              { header: 'tz', get: (s: WorkflowSchedule) => s.timezone ?? '-' },
              {
                header: 'state',
                get: (s: WorkflowSchedule) => s.status,
                color: (s: WorkflowSchedule) => scheduleStateColor(s.status),
              },
              { header: 'last run', get: (s: WorkflowSchedule) => (s.lastRunAt ? formatTimestamp(s.lastRunAt) : '-') },
            ]}
            rows={items}
            hint={`orca workflows schedules get <id> ${glyphs.separator} orca workflows schedules pause <id>`}
          />
        </Panel>,
      )
      printPageHint(items.length, page.total)
    })

  schedules
    .command('get <id>')
    .description('show a workflow schedule')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const s = await withApi(api, (c) => getWorkflowSchedule(c, id))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(s)
        return
      }
      if (mode === 'plain') {
        printPlainRows([scheduleRow(s)])
        return
      }
      const { Panel, Field } = await import('../ui/Panel.js')
      const { scheduleStateColor } = await import('../lib/workflows.js')
      await renderStatic(
        <Panel title={s.id} subtitle={s.name ?? s.workflowDefinitionId}>
          <Field label="definition" value={s.workflowDefinitionId} />
          <Field label="cron" value={s.cron} />
          {s.timezone ? <Field label="tz" value={s.timezone} /> : null}
          <Field label="state" value={s.status} valueColor={scheduleStateColor(s.status)} />
          {s.lastRunAt ? <Field label="last run" value={formatTimestamp(s.lastRunAt)} /> : null}
          {s.lastError ? <Field label="last error" value={s.lastError} /> : null}
        </Panel>,
      )
    })

  schedules
    .command('pause <id>')
    .description('pause a workflow schedule')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const s = await withApi(api, (c) => pauseWorkflowSchedule(c, id))
      if (outputMode(flags) === 'json') printJson(s)
      else {
        const { accentVerb } = await import('../ui/theme.js')
        console.log(`${accentVerb('Paused')} schedule "${id}".`)
      }
    })

  schedules
    .command('resume <id>')
    .description('resume a workflow schedule')
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const s = await withApi(api, (c) => resumeWorkflowSchedule(c, id))
      if (outputMode(flags) === 'json') printJson(s)
      else {
        const { accentVerb } = await import('../ui/theme.js')
        console.log(`${accentVerb('Resumed')} schedule "${id}".`)
      }
    })

  schedules
    .command('delete <id>')
    .description('delete a workflow schedule')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!(await guardDestructive(opts.yes, 'delete', `Delete schedule "${id}"?`))) return
      await withApi(api, (c) => deleteWorkflowSchedule(c, id))
      if (outputMode(flags) === 'json') printJson({ id, deleted: true })
      else {
        const { accentVerb } = await import('../ui/theme.js')
        console.log(`${accentVerb('Deleted')} schedule "${id}".`)
      }
    })
}
