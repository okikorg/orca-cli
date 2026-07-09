import type { Command } from 'commander'

import { DEFAULT_CONTEXT, loadConfig, maskKey, resolveContext, saveConfig } from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { globalFlags } from './shared.js'

export function registerContext(program: Command): void {
  const context = program.command('context').description('manage named platform contexts')

  context
    .command('list')
    .description('list configured contexts')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const cfg = await loadConfig()
      const current = cfg.currentContext ?? DEFAULT_CONTEXT
      const names = Object.keys(cfg.contexts).sort()
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(
          names.map((name) => ({
            name,
            current: name === current,
            apiUrl: cfg.contexts[name].apiUrl ?? null,
            gatewayUrl: cfg.contexts[name].gatewayUrl ?? null,
            hasKey: Boolean(cfg.contexts[name].apiKey),
          })),
        )
        return
      }
      if (names.length === 0) {
        // Empty state: name the command that creates the first context. Kept on
        // stderr (never stdout) so plain/json piping stays clean.
        console.error(hintText('No contexts yet.'))
        console.error(hintText('  sign in to create one: orca auth login'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          names.map((name) => [
            name === current ? '*' : '',
            name,
            cfg.contexts[name].apiUrl ?? '-',
            cfg.contexts[name].apiKey ? maskKey(cfg.contexts[name].apiKey) : '-',
          ]),
        )
        return
      }

      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { POINTER, theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="CONTEXTS" subtitle={`${names.length} total`}>
          <Table
            columns={[
              {
                header: 'current',
                get: (n: string) => (n === current ? POINTER : ''),
                color: (n: string) => (n === current ? theme.accent : undefined),
              },
              { header: 'name', get: (n: string) => n, bold: true },
              { header: 'api url', get: (n: string) => cfg.contexts[n].apiUrl ?? '-' },
              {
                header: 'api key',
                get: (n: string) => (cfg.contexts[n].apiKey ? maskKey(cfg.contexts[n].apiKey) : '-'),
              },
            ]}
            rows={names}
            hint="orca context use <name> · orca context show"
          />
        </Panel>,
      )
    })

  context
    .command('use [name]')
    .description('switch the current context (a picker opens when the name is omitted)')
    .action(async (nameArg: string | undefined) => {
      const cfg = await loadConfig()
      const names = Object.keys(cfg.contexts).sort()

      let name = nameArg
      if (!name) {
        // No name given: open the picker in an interactive TTY. Non-TTY keeps
        // the missing-arg contract (Usage error, exit 2). An empty config names
        // the command that creates the first context.
        if (names.length === 0) {
          throw new CliError('no contexts configured', ExitCode.Usage, [
            'Sign in to create one: orca auth login',
          ])
        }
        if (!interactive()) {
          throw new CliError('context name required in non-interactive mode', ExitCode.Usage, [
            'Usage: orca context use <name>',
          ])
        }
        const { pickOne } = await import('../ui/AgentPicker.js')
        name = await pickOne('Select a context', names)
      }

      if (!cfg.contexts[name]) {
        throw new CliError(`context "${name}" not found`, ExitCode.Usage, [
          'List contexts with: orca context list',
        ])
      }
      cfg.currentContext = name
      await saveConfig(cfg)
      console.log(`${accentVerb('Switched')} to context "${name}".`)
    })

  context
    .command('show')
    .description('show the effective context (config file merged with env overrides)')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      // Resolve the effective context (env > flags > file) so this works in
      // env-only mode (CI, no config file), matching auth status.
      const ctx = await resolveContext(flags)
      // "Configured" means the user set something explicitly (a key, or a
      // non-default URL). A context that resolves only to baked-in defaults
      // still needs `orca auth login` to get a usable key.
      const hasExplicit =
        Boolean(ctx.apiKey) ||
        (Boolean(ctx.apiUrl) && !ctx.defaulted.has('apiUrl')) ||
        (Boolean(ctx.gatewayUrl) && !ctx.defaulted.has('gatewayUrl')) ||
        (Boolean(ctx.dashboardUrl) && !ctx.defaulted.has('dashboardUrl'))
      if (!hasExplicit) {
        throw new CliError(`context "${ctx.name}" is not configured`, ExitCode.Usage, [
          'Run: orca auth login, or set ORCA_API_URL and ORCA_API_KEY.',
        ])
      }
      const mark = (field: 'apiUrl' | 'gatewayUrl' | 'dashboardUrl', value: string): string =>
        ctx.defaulted.has(field) ? `${value} (default)` : value
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson({
          name: ctx.name,
          apiUrl: ctx.apiUrl ?? null,
          gatewayUrl: ctx.gatewayUrl ?? null,
          dashboardUrl: ctx.dashboardUrl ?? null,
          apiKey: ctx.apiKey ? maskKey(ctx.apiKey) : null,
          defaults: [...ctx.defaulted],
        })
        return
      }
      if (mode === 'plain') {
        console.log(`Context:  ${ctx.name}`)
        console.log(`API URL:  ${ctx.apiUrl ? mark('apiUrl', ctx.apiUrl) : '-'}`)
        console.log(`Gateway:  ${ctx.gatewayUrl ? mark('gatewayUrl', ctx.gatewayUrl) : '-'}`)
        console.log(`Dashboard: ${ctx.dashboardUrl ? mark('dashboardUrl', ctx.dashboardUrl) : '-'}`)
        console.log(`API key:  ${ctx.apiKey ? maskKey(ctx.apiKey) : '-'}`)
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="CONTEXT" subtitle={ctx.name}>
          <Field label="api url" value={ctx.apiUrl ? mark('apiUrl', ctx.apiUrl) : '-'} />
          <Field label="gateway" value={ctx.gatewayUrl ? mark('gatewayUrl', ctx.gatewayUrl) : '-'} />
          <Field label="dashboard" value={ctx.dashboardUrl ? mark('dashboardUrl', ctx.dashboardUrl) : '-'} />
          <Field
            label="api key"
            value={ctx.apiKey ? maskKey(ctx.apiKey) : '-'}
            valueColor={ctx.apiKey ? undefined : theme.subtle}
          />
        </Panel>,
      )
    })
}
