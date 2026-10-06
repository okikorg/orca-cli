import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Command } from 'commander'
import type { FileObject } from 'openai/resources/files'

import { toPage } from '../lib/api.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { formatCount, formatTime } from '../lib/format.js'
import { interactive, outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
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

// Uploads can be large; give them longer than a JSON call.
const TRANSFER_TIMEOUT_MS = 10 * 60_000

// Files are the organization's uploaded bytes on /v1/files, which sessions
// and environment templates stage into a workspace.
export function registerFiles(program: Command): void {
  const files = program.command('files').description('manage uploaded files')

  const filesList = files.command('list').description('list files, newest first')
  addPageFlags(filesList)
  filesList.action(async (opts: PageFlags, cmd: Command) => {
    const flags = globalFlags(cmd)
    validatePage(opts, cmd)
    const api = await apiContext(cmd)
    const page = await fetchPageOrAll(opts, (params) =>
      withApi(api, async (c) => toPage(await (await c.v1()).files.list(params))),
    )
    const mode = outputMode(flags)
    if (mode === 'json') {
      printJson(page.items)
      return
    }
    if (page.items.length === 0) {
      console.error(hintText('No files yet.'))
      console.error(hintText('  upload one: orca files upload <path>'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(page.items.map((f) => [f.id, f.filename, f.bytes, formatTime(f.created_at)]))
      printPageHint(page)
      return
    }
    const { Table } = await import('../ui/Table.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Table
        title="Files"
        meta={pagedSubtitle(page)}
        headers
        hint="orca files download <id> · orca files upload <path>"
        columns={[
          { header: 'id', get: (f: FileObject) => f.id, color: () => theme.accent, bold: true },
          { header: 'name', get: (f: FileObject) => f.filename },
          { header: 'bytes', get: (f: FileObject) => formatCount(f.bytes) },
          { header: 'created', get: (f: FileObject) => formatTime(f.created_at) },
        ]}
        rows={page.items}
      />,
    )
    printPageHint(page)
  })

  files
    .command('upload <path>')
    .description('upload a file')
    .option('--name <filename>', 'store it under this name (default: the file\'s own name)')
    .action(async (target: string, opts: { name?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const stat = await fs.stat(target).catch(() => null)
      if (!stat || !stat.isFile()) throw new CliError(`not a file: ${target}`, ExitCode.Usage)
      const api = await apiContext(cmd)
      const { toFile } = await import('openai/uploads')
      const bytes = await fs.readFile(target)
      const file = await withApi(api, async (c) =>
        (await c.v1()).files.create(
          { file: await toFile(bytes, opts.name ?? path.basename(target)), purpose: 'user_data' },
          { timeout: TRANSFER_TIMEOUT_MS },
        ),
      )
      if (outputMode(flags) === 'json') {
        printJson(file)
        return
      }
      if (!process.stdout.isTTY) {
        process.stdout.write(file.id + '\n')
        return
      }
      console.log(`${accentVerb('Uploaded')} ${file.filename} (${file.id}, ${file.bytes} bytes).`)
    })

  files
    .command('download <id>')
    .description('download a file\'s bytes (to stdout with -o -)')
    .option('-o, --output <path>', 'where to write it (default: its stored name in this directory)')
    .action(async (id: string, opts: { output?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const client = await api.client.v1()
      const target =
        opts.output ?? (await withApi(api, () => client.files.retrieve(id))).filename
      const res = await withApi(api, () => client.files.content(id, { timeout: TRANSFER_TIMEOUT_MS }))
      if (!res.body) throw new CliError(`file ${id} has no content`, ExitCode.Failure)
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      if (target === '-') {
        await pipeline(body, process.stdout)
        return
      }
      // A stored name is remote text: never let it climb out of this directory.
      const dest = opts.output ?? path.basename(target)
      await pipeline(body, createWriteStream(dest))
      if (outputMode(flags) === 'json') printJson({ id, path: dest })
      else console.error(`${accentVerb('Saved')} ${id} to ${dest}.`)
    })

  files
    .command('delete <id>')
    .description('delete a file')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete file ${id}?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      await withApi(api, async (c) => (await c.v1()).files.delete(id))
      if (outputMode(flags) === 'json') printJson({ id, deleted: true })
      else console.log(`${accentVerb('Deleted')} file ${id}.`)
    })
}
