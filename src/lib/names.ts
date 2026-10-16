// Resolving what a user typed for an agent, a vault or an environment
// template: the item with that id, else the one item with that name.
//
// The server says which, never the text's shape: the text is retrieved as an
// id first, and only a 404 makes it a name. An id is then used as given. A
// name two items share is ambiguous, so the error lists their ids; the name
// scan stops at the same cap as every --all list.

import type OpenAI from 'openai'
import { NotFoundError } from 'openai/error'
import type { EnvironmentTemplate } from 'openai/resources/beta/agents/environments/templates'
import type { Vault } from 'openai/resources/beta/agents/vaults/vaults'

import { FETCH_ALL_MAX_ROWS, FETCH_ALL_PAGE_SIZE } from './api.js'
import { CliError, ExitCode } from './errors.js'

export type NamedKind = {
  one: string
  many: string
  // The hint under "no <one> named": where to see the names.
  listHint: string
}

type Named = { id: string; name?: string | null }

export async function findByIdOrName<T extends Named>(
  ref: string,
  kind: NamedKind,
  retrieve: (id: string) => Promise<T>,
  list: () => AsyncIterable<T>,
): Promise<T> {
  if (!ref.trim()) throw new CliError(`the ${kind.one} needs an id or a name`, ExitCode.Usage)
  try {
    return await retrieve(ref)
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err
  }
  const matches: T[] = []
  let seen = 0
  for await (const item of list()) {
    if (++seen > FETCH_ALL_MAX_ROWS) {
      throw new CliError(`too many ${kind.many} to find "${ref}" by name`, ExitCode.Usage, ['Pass its id instead.'])
    }
    if (item.name === ref) matches.push(item)
  }
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new CliError(`no ${kind.one} named "${ref}"`, ExitCode.NotFound, [kind.listHint])
  }
  throw new CliError(`${matches.length} ${kind.many} are named "${ref}"`, ExitCode.Usage, [
    `Pass an id instead: ${matches.map((item) => item.id).join(', ')}`,
  ])
}

const VAULT: NamedKind = { one: 'vault', many: 'vaults', listHint: 'List vaults with: orca vaults list' }
const TEMPLATE: NamedKind = {
  one: 'environment template',
  many: 'environment templates',
  listHint: 'Pass its id: orca kits copy prints the id of each template it creates',
}

export function findVault(client: OpenAI, ref: string): Promise<Vault> {
  const vaults = client.beta.agents.vaults
  return findByIdOrName(ref, VAULT, (id) => vaults.retrieve(id), () => vaults.list({ limit: FETCH_ALL_PAGE_SIZE }))
}

export function findTemplate(client: OpenAI, ref: string): Promise<EnvironmentTemplate> {
  const templates = client.beta.agents.environments.templates
  return findByIdOrName(ref, TEMPLATE, (id) => templates.retrieve(id), () => templates.list({ limit: FETCH_ALL_PAGE_SIZE }))
}
