import type { Command } from 'commander'
import type { Agent, AgentCreateParams, AgentUpdateParams } from 'openai/resources/beta/agents/agents'

import { toPage } from '../lib/api.js'
import { loadAgentFile, resolveAgentId } from '../lib/agents.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import {
  addPageFlags,
  apiContext,
  type ApiContext,
  fetchAll,
  fetchPageOrAll,
  globalFlags,
  pagedSubtitle,
  printPageHint,
  validatePage,
  withApi,
  type PageFlags,
} from './shared.js'

// toolLabel names one of an agent's tools for the detail view.
function toolLabel(tool: Agent['tools'][number]): string {
  const rec = tool as unknown as Record<string, unknown>
  if (typeof rec.server_label === 'string') return `mcp:${rec.server_label}`
  if (typeof rec.name === 'string') return rec.name
  return String(rec.type)
}

// resolveAgent returns the agent id for the positional argument; otherwise,
// in an interactive TTY, it opens the filterable picker over the agent list.
// In non-TTY mode a missing argument stays a usage error (exit 2).
async function resolveAgent(ref: string | undefined, verb: string, api: ApiContext): Promise<string> {
  if (ref) return withApi(api, async (c) => resolveAgentId(await c.v1(), ref))
  if (!interactive()) {
    throw new CliError('agent required in non-interactive mode', ExitCode.Usage, [
      `Usage: orca agents ${verb} <agent>`,
    ])
  }
  const page = await fetchAll((params) =>
    withApi(api, async (c) => toPage(await (await c.v1()).beta.agents.list(params))),
  )
  if (page.items.length === 0) {
    throw new CliError('no agents; create one with: orca agents create -f agent.yaml', ExitCode.Usage)
  }
  const { pickOne } = await import('../ui/AgentPicker.js')
  const label = (a: Agent) => `${a.name ?? '(unnamed)'}  ${a.id}`
  const chosen = await pickOne('Select an agent', page.items.map(label))
  return page.items.find((a) => label(a) === chosen)!.id
}

async function renderAgentDetail(a: Agent): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { Box, Text } = await import('ink')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title={a.name ?? a.id} subtitle={a.model}>
      <Field label="id" value={a.id} />
      {a.tools.length ? <Field label="tools" value={a.tools.map(toolLabel).join(', ')} /> : null}
      {a.multi_agent?.enabled ? <Field label="team" value="multi-agent lead" /> : null}
      <Field label="updated" value={formatTime(a.updated_at)} />
      {a.instructions ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.subtle}>instructions</Text>
          <Text color={theme.muted}>{a.instructions}</Text>
        </Box>
      ) : null}
    </Panel>,
  )
}

export function registerAgents(program: Command): void {
  const agents = program.command('agents').description('manage agents')

  const agentsList = agents.command('list').description('list agents, newest first')
  addPageFlags(agentsList)
  agentsList.action(async (opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, async (c) => toPage(await (await c.v1()).beta.agents.list(params))),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No agents yet.'))
      console.error(hintText('  create one: orca agents create -f agent.yaml'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(page.items.map((a) => [a.id, a.name ?? '-', a.model, formatTime(a.updated_at)]))
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Agents"
        meta={pagedSubtitle(page)}
        hint='orca agents get <agent> · orca chat <agent> "prompt"'
        columns={[
          { header: 'name', get: (a: Agent) => a.name ?? '-', color: () => theme.accent, bold: true },
          { header: 'model', get: (a: Agent) => a.model },
          { header: 'updated', get: (a: Agent) => formatTime(a.updated_at) },
          { header: 'id', get: (a: Agent) => a.id, color: () => theme.subtle },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })

  agents
    .command('get [agent]')
    .description('show one agent by id or name (the agent picker opens when omitted)')
    .action(async (ref: string | undefined, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const id = await resolveAgent(ref, 'get', api)
      const agent = await withApi(api, async (c) => (await c.v1()).beta.agents.retrieve(id))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(agent)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['id', agent.id],
          ['name', agent.name ?? '-'],
          ['model', agent.model],
          ['tools', agent.tools.map(toolLabel).join(',') || '-'],
          ['updated', formatTime(agent.updated_at)],
        ])
        return
      }
      await renderAgentDetail(agent)
    })

  agents
    .command('create')
    .description('create an agent from a YAML or JSON file (the POST /v1/agents body)')
    .requiredOption('-f, --file <path>', 'agent document (use - for stdin)')
    .action(async (opts: { file: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const body = await loadAgentFile(opts.file, { requireModel: true })
      const created = await withApi(api, async (c) =>
        (await c.v1()).beta.agents.create(body as unknown as AgentCreateParams),
      )
      if (outputMode(flags) === 'json') printJson(created)
      else console.log(`${accentVerb('Created')} agent "${created.name ?? created.id}" (${created.id}).`)
    })

  agents
    .command('update <agent>')
    .description('update an agent from a YAML or JSON file; fields left out are kept')
    .requiredOption('-f, --file <path>', 'agent fields to change (use - for stdin)')
    .action(async (ref: string, opts: { file: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const body = await loadAgentFile(opts.file, { requireModel: false })
      const id = await resolveAgent(ref, 'update', api)
      const updated = await withApi(api, async (c) => (await c.v1()).beta.agents.update(id, body as AgentUpdateParams))
      if (outputMode(flags) === 'json') printJson(updated)
      else console.log(`${accentVerb('Updated')} agent "${updated.name ?? updated.id}".`)
    })

  agents
    .command('delete [agent]')
    .description('delete an agent (the agent picker opens when omitted)')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (ref: string | undefined, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const id = await resolveAgent(ref, 'delete', api)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete agent ${ref ?? id}?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, async (c) => (await c.v1()).beta.agents.delete(id))
      if (outputMode(flags) === 'json') printJson({ id, deleted: true })
      else console.log(`${accentVerb('Deleted')} agent ${ref ?? id}.`)
    })
}
