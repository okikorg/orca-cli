import { readFile, writeFile } from 'node:fs/promises'

import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import { formatTimestamp } from '../lib/format.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderStatic,
} from '../lib/output.js'
import { accentVerb, glyphs, hintText } from '../ui/theme.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// -- Wire shapes (tenant VFS bucket, the dashboard "Files" page) --------------
// Anchored on the conductor Storage handlers (agent-runtime/runtime/httpapi/
// storage.go) and docs/openapi.sdk.yaml (Storage group). The tenant is derived
// from the bearer key, so no X-Tenant-ID header is sent.

type StorageInfo = {
  configured: boolean
  bucket?: string
  usedBytes: number
  objectCount: number
  capacityBytes?: number
  breakdown?: { prefix: string; bytes: number; count: number }[]
}

type StorageEntry = {
  key: string
  size: number
  lastModified: string
  etag?: string
}

type StorageObjectList = {
  prefix: string
  bucket: string
  entries: StorageEntry[]
  count: number
}

// GET returns the body inline as JSON: text bodies are UTF-8 in `content`,
// non-UTF-8 bodies are base64 (the `encoding` field says which).
type StorageObject = {
  key: string
  contentType?: string
  size: number
  etag?: string
  encoding: string // "text" | "base64"
  content: string
}

type StoragePutResult = {
  key: string
  contentType?: string
  size: number
  etag?: string
}

type StorageDeleteResult = {
  key: string
  deleted: number
}

// encodeStorageKey mirrors the dashboard (dashboard/src/lib/api.ts): the route
// is a Go 1.22 `{key...}` wildcard, so slashes are real path separators. Encode
// each segment but keep the slashes literal, and preserve a trailing slash
// (which the DELETE handler reads as a prefix delete).
function encodeStorageKey(key: string): string {
  const isFolder = key.endsWith('/')
  const trimmed = isFolder ? key.slice(0, -1) : key
  const safe = trimmed.split('/').map(encodeURIComponent).join('/')
  return safe + (isFolder ? '/' : '')
}

// formatBytes renders a byte count as a human-scaled size for TTY views.
// Plain/JSON output keeps the raw integer so it stays scriptable.
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  if (i === 0) return `${v} B`
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}

// A small extension -> Content-Type map so text files round-trip with a
// sensible type. The server preserves whatever Content-Type is sent; unknown
// extensions fall back to application/octet-stream. Override with --content-type.
const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  ts: 'application/typescript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
}

function guessContentType(file: string): string {
  const dot = file.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[file.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

// decodeStorageObject reconstructs the exact bytes the object holds, honoring
// the server's text/base64 encoding flag.
function decodeStorageObject(o: StorageObject): Buffer {
  return o.encoding === 'base64'
    ? Buffer.from(o.content, 'base64')
    : Buffer.from(o.content, 'utf8')
}

function isTextContentType(ct: string): boolean {
  const t = ct.split(';')[0].trim().toLowerCase()
  if (t.startsWith('text/')) return true
  if (/[+/](json|xml|yaml|javascript|typescript|csv)$/.test(t)) return true
  return ['application/x-ndjson', 'image/svg+xml'].includes(t)
}

// isBinaryObject decides whether dumping to a live terminal would be unsafe:
// the server flagged it base64 (non-UTF-8), the bytes carry a NUL, or the
// Content-Type is not text-shaped.
function isBinaryObject(o: StorageObject, bytes: Buffer): boolean {
  if (o.encoding === 'base64') return true
  if (bytes.includes(0)) return true
  if (o.contentType && !isTextContentType(o.contentType)) return true
  return false
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

export function registerStorage(program: Command): void {
  const storage = program.command('storage').description('manage tenant storage objects')

  storage
    .command('info')
    .description('show bucket usage')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const info = await withApi(api, (c) => c.request<StorageInfo>('/api/storage/info'))
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(info)
        return
      }
      if (!info.configured) {
        console.error(hintText('Storage is not configured for this tenant.'))
        console.error(hintText('  enable it in the dashboard, then: orca storage ls'))
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['bucket', info.bucket ?? '-'],
          ['usedBytes', info.usedBytes],
          ['objectCount', info.objectCount],
          ['capacityBytes', info.capacityBytes ?? ''],
        ])
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { Box, Text } = await import('ink')
      const { Table } = await import('../ui/Table.js')
      const { theme } = await import('../ui/theme.js')
      const pct =
        info.capacityBytes && info.capacityBytes > 0
          ? `${((info.usedBytes / info.capacityBytes) * 100).toFixed(1)}%`
          : null
      await renderStatic(
        <Panel title="STORAGE" subtitle={info.bucket}>
          <Field label="used" value={formatBytes(info.usedBytes)} />
          <Field label="objects" value={String(info.objectCount)} />
          {info.capacityBytes ? (
            <Field label="capacity" value={`${formatBytes(info.capacityBytes)}${pct ? ` (${pct} used)` : ''}`} />
          ) : null}
          {info.breakdown?.length ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.subtle}>by prefix</Text>
              <Table
                columns={[
                  { header: 'prefix', get: (b: { prefix: string }) => b.prefix, color: () => theme.accent, bold: true },
                  { header: 'size', get: (b: { bytes: number }) => formatBytes(b.bytes) },
                  { header: 'objects', get: (b: { count: number }) => String(b.count) },
                ]}
                rows={info.breakdown}
              />
            </Box>
          ) : null}
        </Panel>,
      )
    })

  storage
    .command('ls [prefix]')
    .description('list objects under an optional prefix')
    .option('--limit <n>', 'page size (default 100, max 1000)', (v) => parseInt(v, 10))
    .action(async (prefix: string | undefined, opts: { limit?: number }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const sp = new URLSearchParams()
      if (prefix) sp.set('prefix', prefix)
      if (opts.limit != null) sp.set('limit', String(opts.limit))
      const qs = sp.toString()
      const list = await withApi(api, (c) =>
        c.request<StorageObjectList>(`/api/storage/objects${qs ? `?${qs}` : ''}`),
      )
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(list)
        return
      }
      if (list.entries.length === 0) {
        console.error(hintText(prefix ? `No objects under "${prefix}" yet.` : 'No objects yet.'))
        console.error(hintText('  upload one: orca storage put <key> <file>'))
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          list.entries.map((e) => [e.key, e.size, formatTimestamp(e.lastModified)]),
        )
        return
      }

      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      const subtitle = list.prefix ? `${list.count} under ${list.prefix}` : `${list.count} total`
      await renderStatic(
        <Panel title="STORAGE" subtitle={subtitle}>
          <Table
            columns={[
              { header: 'key', get: (e: StorageEntry) => e.key, color: () => theme.accent, bold: true },
              { header: 'size', get: (e: StorageEntry) => formatBytes(e.size) },
              { header: 'modified', get: (e: StorageEntry) => formatTimestamp(e.lastModified) },
            ]}
            rows={list.entries}
            headers
            hint={`orca storage get <key> ${glyphs.separator} orca storage rm <key>`}
          />
        </Panel>,
      )
    })

  storage
    .command('get <key>')
    .description('download an object; bytes go to stdout when piped, or to --output')
    .option('-o, --output <file>', 'write the object bytes to a file instead of stdout')
    .action(async (key: string, opts: { output?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const obj = await withApi(api, (c) =>
        c.request<StorageObject>(`/api/storage/objects/${encodeStorageKey(key)}`),
      )
      const bytes = decodeStorageObject(obj)

      // --output always writes exact bytes to a file; stdout stays empty so the
      // command is safe to run in any mode.
      if (opts.output) {
        try {
          await writeFile(opts.output, bytes)
        } catch (err) {
          throw new CliError(
            `cannot write ${opts.output}: ${err instanceof Error ? err.message : String(err)}`,
            ExitCode.Failure,
          )
        }
        console.error(`${accentVerb('Saved')} ${obj.key} (${formatBytes(bytes.length)}) -> ${opts.output}`)
        return
      }

      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(obj)
        return
      }
      // A live terminal (ink) must not be flooded with binary. Piped output
      // (plain) gets the raw bytes and nothing else, so redirects keep fidelity.
      if (mode === 'ink' && isBinaryObject(obj, bytes)) {
        throw new CliError(
          `refusing to write binary object "${obj.key}" to the terminal`,
          ExitCode.Usage,
          ['Use --output <file> to save it, or pipe stdout elsewhere (orca storage get ... > file).'],
        )
      }
      process.stdout.write(bytes)
    })

  storage
    .command('put <key> <file>')
    .description('upload a local file to <key> (upsert; overwrites any existing object)')
    .option('--content-type <type>', 'Content-Type to store (default: guessed from the file extension)')
    .action(async (key: string, file: string, opts: { contentType?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (key.endsWith('/')) {
        throw new CliError('key must not end with "/" (that denotes a prefix)', ExitCode.Usage)
      }
      let body: Buffer
      try {
        body = await readFile(file)
      } catch (err) {
        throw new CliError(
          `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
          ExitCode.Usage,
        )
      }
      const contentType = opts.contentType ?? guessContentType(file)
      const result = await withApi(api, (c) =>
        c.request<StoragePutResult>(`/api/storage/objects/${encodeStorageKey(key)}`, {
          method: 'PUT',
          body,
          headers: { 'Content-Type': contentType },
        }),
      )
      if (outputMode(flags) === 'json') {
        printJson(result)
        return
      }
      console.log(`${accentVerb('Uploaded')} ${file} -> ${result.key} (${formatBytes(result.size)}).`)
    })

  storage
    .command('rm <key>')
    .description('delete an object, or a whole prefix when <key> ends with "/"')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (key: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const isPrefix = key.endsWith('/')
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        const question = isPrefix
          ? `Delete every object under "${key}"?`
          : `Delete object "${key}"?`
        if (!(await confirmDestructive(question))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      const result = await withApi(api, (c) =>
        c.request<StorageDeleteResult>(`/api/storage/objects/${encodeStorageKey(key)}`, {
          method: 'DELETE',
        }),
      )
      if (outputMode(flags) === 'json') {
        printJson(result)
        return
      }
      const n = result.deleted
      const where = isPrefix ? ` under "${key}"` : ` (${result.key})`
      console.log(`${accentVerb('Deleted')} ${n} object${n === 1 ? '' : 's'}${where}.`)
    })
}
