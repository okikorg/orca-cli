// Agent helpers shared by the commands that name an agent: reading an agent
// document from a file, and resolving the id or name a user typed.

import { readFile } from 'node:fs/promises'

import { load as parseYaml, YAMLException } from 'js-yaml'
import type OpenAI from 'openai'
import type { Agent } from 'openai/resources/beta/agents/agents'
import { NotFoundError } from 'openai/error'

import { FETCH_ALL_MAX_ROWS, FETCH_ALL_PAGE_SIZE } from './api.js'
import { CliError, ExitCode } from './errors.js'

async function readSource(file: string): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
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
// rejects. A create needs a model; an update may change any subset.
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
      'Example: { model: openai/gpt-5, name: support, instructions: "..." }',
    ])
  }
  const doc = raw as Record<string, unknown>
  if (opts.requireModel && (typeof doc.model !== 'string' || !doc.model.trim())) {
    throw new CliError(`${label} needs a model`, ExitCode.Usage, [
      'Name it with a provider prefix, such as model: openai/gpt-5',
    ])
  }
  return doc
}

// findAgent turns what the user typed into an agent: the agent with that id,
// else the one agent with that name. The server says which, never the
// text's shape. A name two agents share is ambiguous, so the error lists
// their ids; the name scan stops at the same cap as every --all list.
export async function findAgent(client: OpenAI, ref: string): Promise<Agent> {
  try {
    return await client.beta.agents.retrieve(ref)
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err
  }
  const matches: Agent[] = []
  let seen = 0
  for await (const agent of client.beta.agents.list({ limit: FETCH_ALL_PAGE_SIZE })) {
    if (++seen > FETCH_ALL_MAX_ROWS) {
      throw new CliError(`too many agents to find "${ref}" by name`, ExitCode.Usage, ['Pass its id instead.'])
    }
    if (agent.name === ref) matches.push(agent)
  }
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new CliError(`no agent named "${ref}"`, ExitCode.NotFound, ['List agents with: orca agents list'])
  }
  throw new CliError(`${matches.length} agents are named "${ref}"`, ExitCode.Usage, [
    `Pass an id instead: ${matches.map((agent) => agent.id).join(', ')}`,
  ])
}

// resolveAgentId is findAgent's id.
export async function resolveAgentId(client: OpenAI, ref: string): Promise<string> {
  return (await findAgent(client, ref)).id
}
