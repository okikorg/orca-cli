// Agent helpers shared by the commands that name an agent: reading an agent
// document from a file, and resolving the id or name a user typed.

import { readFile } from 'node:fs/promises'

import { load as parseYaml, YAMLException } from 'js-yaml'
import type OpenAI from 'openai'
import type { Agent } from 'openai/resources/beta/agents/agents'

import { FETCH_ALL_PAGE_SIZE } from './api.js'
import { CliError, ExitCode } from './errors.js'
import { findByIdOrName } from './names.js'
import { readStdin } from './stdin.js'

async function readSource(file: string): Promise<string> {
  if (file === '-') return readStdin()
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`file not found: ${file}`, ExitCode.Usage)
    }
    throw err
  }
}

// loadAgentFile reads a YAML or JSON agent document (or stdin via "-"): the
// body of POST /v1/agents (model, name, instructions, tools, reasoning, ...).
// YAML is a superset of JSON, so one parser covers both. Only the shape is
// checked here; the server validates every field and names the one it
// rejects. A create needs a model, from the file or, in a terminal, the
// model picker (`agents create`); an update may change any subset.
export async function loadAgentFile(
  file: string,
  opts: { requireModel: boolean },
): Promise<Record<string, unknown>> {
  const label = file === '-' ? 'stdin' : file
  const source = await readSource(file)
  if (!source.trim()) throw new CliError(`${label} is empty`, ExitCode.Usage)
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    const reason = err instanceof YAMLException ? err.message.split('\n')[0] : String(err)
    throw new CliError(`could not parse ${label}: ${reason}`, ExitCode.Usage)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`${label} must hold one agent object`, ExitCode.Usage, [
      'Example: { model: orca/openrouter/openai/gpt-5.6-luna, name: support, instructions: "..." }',
    ])
  }
  const doc = raw as Record<string, unknown>
  if (opts.requireModel && !hasModel(doc)) throw missingModel(label)
  return doc
}

export function hasModel(doc: Record<string, unknown>): boolean {
  return typeof doc.model === 'string' && Boolean(doc.model.trim())
}

// missingModel is the refusal of an agent file with no model, outside a
// terminal or with --json, where no picker opens.
export function missingModel(label: string): CliError {
  return new CliError(`${label} needs a model`, ExitCode.Usage, [
    'Name who pays: model: orca/openrouter/<OpenRouter id> for Orca credit,',
    'or <provider>/<id> with your own key, such as model: anthropic/claude-sonnet-4-5',
  ])
}

// findAgent turns what the user typed into an agent: the agent with that id,
// else the one agent with that name (see names.ts).
export function findAgent(client: OpenAI, ref: string): Promise<Agent> {
  const agents = client.beta.agents
  return findByIdOrName(ref, AGENT, (id) => agents.retrieve(id), () => agents.list({ limit: FETCH_ALL_PAGE_SIZE }))
}

const AGENT = { one: 'agent', many: 'agents', listHint: 'List agents with: orca agents list' }

// resolveAgentId is findAgent's id.
export async function resolveAgentId(client: OpenAI, ref: string): Promise<string> {
  return (await findAgent(client, ref)).id
}
