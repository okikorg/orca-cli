import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { APIKey } from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirmDestructive, revealIssuedKey } from './prompts.js'
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

export function registerKeys(program: Command): void {
  const keys = program
    .command('keys')
    .description('manage API keys (the keys this CLI and the SDKs authenticate with)')

  const keysList = keys
    .command('list')
    .description('list active API keys, newest first (members see their own, admins all)')
  addPageFlags(keysList)
  keysList.action(async (opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) => withApi(api, (c) => c.listKeys(params)))
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No API keys yet.'))
      console.error(hintText('  create one: orca keys create <name>'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(
        page.items.map((k) => [k.id, k.name, k.role, formatTime(k.created_at), formatTime(k.last_used_at)]),
      )
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { Panel } = await import('../ui/Panel.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Panel title="API KEYS" subtitle={pagedSubtitle(page)}>
        <Table
          columns={[
            { header: 'id', get: (k: APIKey) => k.id, color: () => theme.accent, bold: true },
            { header: 'name', get: (k: APIKey) => k.name },
            { header: 'role', get: (k: APIKey) => k.role },
            { header: 'created', get: (k: APIKey) => formatTime(k.created_at) },
            { header: 'last used', get: (k: APIKey) => formatTime(k.last_used_at) },
          ]}
          rows={page.items}
          headers
          hint="orca keys create <name> · orca keys revoke <id>"
        />
      </Panel>,
    )
    printPageHint(page)
  })

  keys
    .command('create [name]')
    .description('mint an API key with your role (the secret is shown once)')
    .action(async (name: string | undefined, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      let keyName = name
      if (!keyName) {
        if (!interactive()) {
          throw new CliError('key name required in non-interactive mode', ExitCode.Usage, [
            'Usage: orca keys create <name>',
          ])
        }
        const { promptText } = await import('../ui/PromptInput.js')
        keyName = (await promptText({ label: 'Key name' })).trim()
        if (!keyName) throw new CliError('empty key name', ExitCode.Usage)
      }
      const issued = await withApi(api, (c) => c.createKey(keyName))
      await revealIssuedKey(issued, `API key "${keyName}"`, outputMode(flags) === 'json')
    })

  keys
    .command('revoke <id>')
    .description('revoke an API key')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to revoke without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirmDestructive(`Revoke key ${id}? Anything authenticating with it stops working.`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.revokeKey(id))
      if (outputMode(flags) === 'json') printJson({ id, revoked: true })
      else console.log(`${accentVerb('Revoked')} key ${id}.`)
    })
}
