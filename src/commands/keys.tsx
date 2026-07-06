import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import type { ControlPlaneAPIKeyMetadata } from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm, revealIssuedKey } from './prompts.js'
import { apiContext, globalFlags, withApi } from './shared.js'

export function registerKeys(program: Command): void {
  const keys = program
    .command('keys')
    .description('manage tenant API keys (the keys this CLI and the SDKs authenticate with)')

  keys
    .command('list')
    .description('list tenant API keys')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const items = await withApi(api, (c) => c.listControlPlaneKeys())
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(items)
        return
      }
      if (items.length === 0) {
        console.error(hintText('No API keys. Create one with: orca keys create <name>'))
        return
      }
      const state = (k: ControlPlaneAPIKeyMetadata) =>
        k.revokedAt ? 'revoked' : k.expiresAt ? `expires ${k.expiresAt}` : 'active'
      if (mode === 'plain') {
        printPlainRows(items.map((k) => [k.id, k.name, k.role, k.createdAt, k.lastUsedAt ?? '-', state(k)]))
        return
      }
      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="API KEYS" subtitle={`${items.length} total`}>
          <Table
            columns={[
              { header: 'id', get: (k: ControlPlaneAPIKeyMetadata) => k.id, color: () => theme.accent, bold: true },
              { header: 'name', get: (k: ControlPlaneAPIKeyMetadata) => k.name },
              { header: 'role', get: (k: ControlPlaneAPIKeyMetadata) => k.role },
              { header: 'created', get: (k: ControlPlaneAPIKeyMetadata) => k.createdAt },
              { header: 'last used', get: (k: ControlPlaneAPIKeyMetadata) => k.lastUsedAt ?? '-' },
              {
                header: 'state',
                get: state,
                color: (k: ControlPlaneAPIKeyMetadata) => (k.revokedAt ? theme.subtle : undefined),
              },
            ]}
            rows={items}
          />
        </Panel>,
      )
    })

  keys
    .command('create [name]')
    .description('issue a tenant API key (the token is shown once)')
    .option('--expires <iso8601>', 'expiry timestamp')
    .action(async (name: string | undefined, opts: { expires?: string }, cmd: Command) => {
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
      const issued = await withApi(api, (c) =>
        c.createControlPlaneKey({ name: keyName, ...(opts.expires ? { expiresAt: opts.expires } : {}) }),
      )
      await revealIssuedKey(issued, `Tenant API key "${keyName}"`, outputMode(flags) === 'json')
    })

  keys
    .command('revoke <id>')
    .description('revoke a tenant API key')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to revoke without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Revoke key ${id}? Anything authenticating with it stops working.`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.revokeControlPlaneKey(id))
      if (outputMode(flags) === 'json') printJson({ id, revoked: true })
      else console.log(`${accentVerb('Revoked')} key ${id}.`)
    })
}
