import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderStatic,
} from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
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

// Metadata-only projection of a secrets row. Plaintext and ciphertext are
// NEVER present on the wire - list/read endpoints never return them, and the
// CLI never prints a value. `key` is the canonical variable name the value is
// meant to populate (e.g. ANTHROPIC_API_KEY); empty for untyped rows.
type SecretMeta = {
  name: string
  key?: string
  description?: string
  algorithm: string
  createdAt: string
  updatedAt: string
}

function secretPath(name: string): string {
  return `/api/secrets/${encodeURIComponent(name)}`
}

// confirmDestructive mounts the shared Confirm component for a y/N gate in
// interactive TTY mode (single keypress; Enter declines). Non-TTY callers
// require --yes and throw a Usage error before reaching here, so the machine
// contract is unchanged. Local per command because the shared prompts module
// belongs to another wave; the mount pattern mirrors pickOne/promptText.
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

// stripOneTrailingNewline drops a single trailing newline so the common
// `printf | orca` and `echo | orca` shapes both round-trip cleanly. Interior
// newlines and additional trailing newlines are preserved verbatim - only the
// one the shell almost always appends is removed.
function stripOneTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2)
  if (s.endsWith('\n')) return s.slice(0, -1)
  return s
}

// readStdin drains stdin to a string. Used for the piped `... | orca secrets
// set NAME` shape.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// resolveSecretValue obtains the plaintext to store WITHOUT ever echoing it.
// Precedence: --value flag, then piped stdin, then a masked interactive
// prompt. The returned string flows only into the request body; it is never
// logged, printed, or placed in an error message.
async function resolveSecretValue(name: string, valueFlag?: string): Promise<string> {
  if (valueFlag !== undefined) {
    if (valueFlag === '') {
      throw new CliError('--value must not be empty', ExitCode.Usage)
    }
    return valueFlag
  }
  // Not a TTY on stdin => a value is being piped in.
  if (!process.stdin.isTTY) {
    const piped = stripOneTrailingNewline(await readStdin())
    if (piped === '') {
      throw new CliError(`no value provided for secret "${name}"`, ExitCode.Usage, [
        'Pass --value, pipe the value on stdin, or run in a terminal to be prompted.',
      ])
    }
    return piped
  }
  // Interactive: prompt with a masked field so the value never appears
  // on screen.
  if (interactive()) {
    const { promptText } = await import('../ui/PromptInput.js')
    const entered = await promptText({ label: `Value for "${name}"`, hint: '(hidden)', mask: true })
    if (entered === '') {
      throw new CliError('value must not be empty', ExitCode.Usage)
    }
    return entered
  }
  throw new CliError(`cannot read a value for secret "${name}"`, ExitCode.Usage, [
    'Pass --value or pipe the value on stdin.',
  ])
}

// keyCell / updatedCell keep list rendering consistent across sinks.
function keyCell(s: SecretMeta): string {
  return s.key && s.key.trim() !== '' ? s.key : '-'
}

async function renderSecretList(list: SecretMeta[], total: number): Promise<void> {
  const { Table } = await import('../ui/Table.js')
  const { Panel } = await import('../ui/Panel.js')
  const { theme } = await import('../ui/theme.js')
  await renderStatic(
    <Panel title="SECRETS" subtitle={pagedSubtitle(list.length, total)}>
      <Table
        columns={[
          { header: 'name', get: (s: SecretMeta) => s.name, color: () => theme.accent, bold: true },
          { header: 'key', get: keyCell },
          { header: 'algorithm', get: (s: SecretMeta) => s.algorithm },
          { header: 'updated', get: (s: SecretMeta) => s.updatedAt },
          { header: 'description', get: (s: SecretMeta) => s.description ?? '-' },
        ]}
        rows={list}
        headers
        hint="orca secrets set NAME --value V"
      />
    </Panel>,
  )
}

export function registerSecrets(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('manage tenant secrets (values are write-only and never shown)')

  // -- list -------------------------------------------------------------------
  const secretsList = secrets
    .command('list')
    .description('list secret metadata (names and key hints only, never values)')
  addPageFlags(secretsList)
  secretsList.action(async (opts: PageFlags, cmd: Command) => {
      const flags = globalFlags(cmd)
      validatePage(opts, cmd)
      const api = await apiContext(cmd)
      const page = await fetchPageOrAll<SecretMeta>(opts, (params) =>
        withApi(api, (c) => c.listSecrets<SecretMeta>(params)),
      )
      const list = page.items
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(list)
        return
      }
      if (list.length === 0) {
        console.error(hintText('No secrets yet.'))
        console.error(hintText('  set one: orca secrets set NAME --value V'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          list.map((s) => [s.name, keyCell(s), s.algorithm, s.updatedAt, s.description ?? '-']),
        )
        printPageHint(list.length, page.total)
        return
      }
      await renderSecretList(list, page.total)
      printPageHint(list.length, page.total)
    })

  // -- set (upsert) -----------------------------------------------------------
  secrets
    .command('set <name>')
    .description('create or replace a secret (value from --value, stdin, or a hidden prompt)')
    .option('--value <value>', 'the secret value (omit to read from stdin or a hidden prompt)')
    .option('--key <key>', 'canonical variable name the value populates (e.g. ANTHROPIC_API_KEY)')
    .option('--description <text>', 'human-readable description')
    .action(
      async (
        name: string,
        opts: { value?: string; key?: string; description?: string },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        const plaintext = await resolveSecretValue(name, opts.value)
        // The body is the ONLY place the plaintext travels. It is never
        // logged and never returned by the server on the response.
        const body = {
          plaintext,
          ...(opts.key ? { key: opts.key } : {}),
          ...(opts.description ? { description: opts.description } : {}),
        }
        const updated = await withApi(api, (c) =>
          c.request<SecretMeta>(secretPath(name), {
            method: 'PUT',
            body: JSON.stringify(body),
          }),
        )
        if (outputMode(flags) === 'json') {
          // Metadata only - the server never echoes plaintext.
          printJson(updated)
          return
        }
        console.log(`${accentVerb('Set')} secret "${name}".`)
      },
    )

  // -- delete -----------------------------------------------------------------
  secrets
    .command('delete <name>')
    .description('delete a secret')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirmDestructive(`Delete secret "${name}"?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, (c) => c.request<unknown>(secretPath(name), { method: 'DELETE' }))
      if (outputMode(flags) === 'json') printJson({ name, deleted: true })
      else console.log(`${accentVerb('Deleted')} secret "${name}".`)
    })
}
