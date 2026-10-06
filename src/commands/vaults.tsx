import type { Command } from 'commander'
import type { Vault } from 'openai/resources/beta/agents/vaults/vaults'
import type { Credential } from 'openai/resources/beta/agents/vaults/credentials'

import { toPage } from '../lib/api.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirmDestructive } from './prompts.js'
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

// stripOneTrailingNewline drops a single trailing newline so the common
// `printf | orca` and `echo | orca` shapes both round-trip cleanly.
function stripOneTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2)
  if (s.endsWith('\n')) return s.slice(0, -1)
  return s
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

// resolveToken obtains the bearer token WITHOUT ever echoing it. Precedence:
// --token, then piped stdin, then a masked interactive prompt. The value flows
// only into the request body; it is never logged, printed, or placed in an
// error message, and the server never returns it.
async function resolveToken(name: string, flag?: string): Promise<string> {
  if (flag !== undefined) {
    if (flag === '') throw new CliError('--token must not be empty', ExitCode.Usage)
    return flag
  }
  if (!process.stdin.isTTY) {
    const piped = stripOneTrailingNewline(await readStdin())
    if (piped === '') {
      throw new CliError(`no token provided for credential "${name}"`, ExitCode.Usage, [
        'Pass --token, pipe the token on stdin, or run in a terminal to be prompted.',
      ])
    }
    return piped
  }
  if (interactive()) {
    const { promptText } = await import('../ui/PromptInput.js')
    const entered = await promptText({ label: `Token for "${name}"`, hint: '(hidden)', mask: true })
    if (entered === '') throw new CliError('token must not be empty', ExitCode.Usage)
    return entered
  }
  throw new CliError(`cannot read a token for credential "${name}"`, ExitCode.Usage, [
    'Pass --token or pipe the token on stdin.',
  ])
}

function serverCell(c: Credential): string {
  const url = (c.auth as { mcp_server_url?: string | null }).mcp_server_url
  return url ?? '-'
}

// Vaults hold the credentials an agent's MCP tools use. Values are sealed on
// the server and never returned; a session gets a vault with --vault.
export function registerVaults(program: Command): void {
  const vaults = program
    .command('vaults')
    .description('manage vaults and the MCP credentials in them (values are write-only)')

  const vaultsList = vaults.command('list').description('list vaults, newest first')
  addPageFlags(vaultsList)
  vaultsList.action(async (opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, async (c) => toPage(await (await c.v1()).beta.agents.vaults.list(params))),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No vaults yet.'))
      console.error(hintText('  create one: orca vaults create <name>'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(page.items.map((v) => [v.id, v.name ?? '-', formatTime(v.created_at)]))
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Vaults"
        meta={pagedSubtitle(page)}
        headers
        hint="orca vaults credentials list <vault id>"
        columns={[
          { header: 'id', get: (v: Vault) => v.id, color: () => theme.accent, bold: true },
          { header: 'name', get: (v: Vault) => v.name ?? '-' },
          { header: 'created', get: (v: Vault) => formatTime(v.created_at) },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })

  vaults
    .command('create <name>')
    .description('create a vault (admin)')
    .action(async (name: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const vault = await withApi(api, async (c) => (await c.v1()).beta.agents.vaults.create({ name }))
      if (outputMode(flags) === 'json') printJson(vault)
      else console.log(`${accentVerb('Created')} vault "${name}" (${vault.id}).`)
    })

  vaults
    .command('delete <id>')
    .description('delete a vault and every credential in it (admin)')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirmDestructive(`Delete vault ${id} and its credentials?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, async (c) => (await c.v1()).beta.agents.vaults.delete(id))
      if (outputMode(flags) === 'json') printJson({ id, deleted: true })
      else console.log(`${accentVerb('Deleted')} vault ${id}.`)
    })

  const credentials = vaults.command('credentials').description('manage the credentials in a vault')

  const credentialsList = credentials.command('list <vault>').description('list a vault\'s credentials')
  addPageFlags(credentialsList)
  credentialsList.action(async (vault: string, opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, async (c) => toPage(await (await c.v1()).beta.agents.vaults.credentials.list(vault, params))),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No credentials in this vault yet.'))
      console.error(hintText(`  add one: orca vaults credentials add ${vault} --name <name> --server <url>`))
      return
    }
    if (mode === 'plain') {
      printPlainRows(page.items.map((c) => [c.id, c.name, c.auth.type, serverCell(c), formatTime(c.updated_at)]))
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Credentials"
        meta={[vault, pagedSubtitle(page)]}
        headers
        columns={[
          { header: 'id', get: (c: Credential) => c.id, color: () => theme.accent, bold: true },
          { header: 'name', get: (c: Credential) => c.name },
          { header: 'type', get: (c: Credential) => c.auth.type },
          { header: 'server', get: serverCell },
          { header: 'updated', get: (c: Credential) => formatTime(c.updated_at) },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })

  credentials
    .command('add <vault>')
    .description('add a bearer token for an MCP server (admin; the token from --token, stdin, or a hidden prompt)')
    .requiredOption('--name <name>', 'credential name')
    .requiredOption('--server <url>', 'the MCP server URL the token is for (https)')
    .option('--token <token>', 'the token (omit to read from stdin or a hidden prompt)')
    .action(async (vault: string, opts: { name: string; server: string; token?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const token = await resolveToken(opts.name, opts.token)
      const credential = await withApi(api, async (c) =>
        (await c.v1()).beta.agents.vaults.credentials.create(vault, {
          name: opts.name,
          auth: { type: 'static_bearer', mcp_server_url: opts.server, token },
        }),
      )
      if (outputMode(flags) === 'json') printJson(credential)
      else console.log(`${accentVerb('Added')} credential "${opts.name}" (${credential.id}) to vault ${vault}.`)
    })

  credentials
    .command('delete <vault> <id>')
    .description('delete a credential (admin)')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (vault: string, id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirmDestructive(`Delete credential ${id}? Sessions using it lose access.`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, async (c) => (await c.v1()).beta.agents.vaults.credentials.delete(id, { vault_id: vault }))
      if (outputMode(flags) === 'json') printJson({ vault, id, deleted: true })
      else console.log(`${accentVerb('Deleted')} credential ${id}.`)
    })
}
