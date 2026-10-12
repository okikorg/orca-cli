// Moving bytes between this machine and the server: uploads to /v1/files,
// and downloads streamed to a file or stdout. `orca files`, `orca sessions
// artifacts`, `--file` and the MCP server share them.

import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type OpenAI from 'openai'
import type { FileObject } from 'openai/resources/files'

import { CliError, ExitCode } from './errors.js'

// Uploads and downloads can be large; give them longer than a JSON call.
export const TRANSFER_TIMEOUT_MS = 10 * 60_000

// uploadFile uploads one file on this machine as user_data, under its own
// name unless another is given.
export async function uploadFile(client: OpenAI, local: string, name?: string): Promise<FileObject> {
  const { toFile } = await import('openai/uploads')
  const bytes = await fs.readFile(local)
  return client.files.create(
    { file: await toFile(bytes, name ?? path.basename(local)), purpose: 'user_data' },
    { timeout: TRANSFER_TIMEOUT_MS },
  )
}

// saveBody streams a download's body to a file, or to stdout for `-`.
export async function saveBody(res: Response, dest: string, what: string): Promise<void> {
  if (!res.body) throw new CliError(`${what} has no content`, ExitCode.Failure)
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  await pipeline(body, dest === '-' ? process.stdout : createWriteStream(dest))
}

// remoteName is the file name a remote path or stored name is saved under:
// its last part only, so remote text never names a folder. A name that is
// empty, `.` or `..` is refused.
export function remoteName(remote: string): string {
  const name = path.basename(remote.replace(/\\/g, '/'))
  if (!name || name === '.' || name === '..') {
    throw new CliError(`refusing to save "${remote}": it has no file name`, ExitCode.Failure)
  }
  return name
}

// inFolder joins a remote file name onto a folder and checks the result
// stays inside it.
export function inFolder(folder: string, remote: string): string {
  const root = path.resolve(folder)
  const dest = path.resolve(root, remoteName(remote))
  if (path.dirname(dest) !== root) {
    throw new CliError(`refusing to save "${remote}" outside ${folder}`, ExitCode.Failure)
  }
  return dest
}
