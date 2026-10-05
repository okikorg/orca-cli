import type { Command } from 'commander'

import { resolveAgentId } from '../lib/agents.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { APIKey } from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirmDestructive, revealIssuedKey } from './prompts.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// Publishing an agent mints an API key scoped to it: whoever holds the key
// can create sessions of that agent on /v1 and talk to them, charged to this
// organization. An agent stays published while it has an active scoped key.
export function registerPublish(program: Command): void {
  const publish = program
    .command('publish')
    .description('publish agents: mint, list, and revoke keys scoped to one agent')

  publish
    .command('create <agent>')
    .description('publish an agent by minting a key scoped to it (admin; the secret is shown once)')
    .requiredOption('--label <label>', 'name the key, such as where it is used')
    .action(async (ref: string, opts: { label: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const label = opts.label.trim()
      if (!label) throw new CliError('--label must not be empty', ExitCode.Usage)
      const api = await apiContext(cmd)
      const agentId = await withApi(api, async (c) => resolveAgentId(await c.v1(), ref))
      const issued = await withApi(api, (c) => c.publishAgent(agentId, label))
      await revealIssuedKey(issued, `Key for ${ref} "${label}"`, outputMode(flags) === 'json')
      if (outputMode(flags) !== 'json') {
        console.error(hintText('Use it as the API key of any OpenAI client pointed at this server\'s /v1.'))
      }
    })

  publish
    .command('list <agent>')
    .description('list the keys an agent is published with')
    .action(async (ref: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const agentId = await withApi(api, async (c) => resolveAgentId(await c.v1(), ref))
      const keys = await withApi(api, (c) => c.publishedKeys(agentId))
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(keys)
        return
      }
      if (keys.length === 0) {
        console.error(hintText(`${ref} is not published.`))
        console.error(hintText(`  publish it: orca publish create ${ref} --label <label>`))
        return
      }
      if (mode === 'plain') {
        printPlainRows(keys.map((k) => [k.id, k.name, formatTime(k.created_at), formatTime(k.last_used_at)]))
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Table
          title="Published keys"
          meta={[ref, `${keys.length} total`]}
          hint="orca publish revoke <key id>"
          headers
          columns={[
            { header: 'id', get: (k: APIKey) => k.id, color: () => theme.accent, bold: true },
            { header: 'label', get: (k: APIKey) => k.name },
            { header: 'created', get: (k: APIKey) => formatTime(k.created_at) },
            { header: 'last used', get: (k: APIKey) => formatTime(k.last_used_at) },
          ]}
          rows={keys}
        />,
      )
    })

  publish
    .command('revoke <key-id>')
    .description('revoke a published agent\'s key; revoking its last key unpublishes it')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to revoke without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirmDestructive(`Revoke key ${id}? Clients using it start failing.`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.revokeKey(id))
      if (outputMode(flags) === 'json') printJson({ id, revoked: true })
      else console.log(`${accentVerb('Revoked')} key ${id}.`)
    })
}
