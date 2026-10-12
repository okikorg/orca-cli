// Staging files on this machine into a session's sandbox (`--file`, and the
// MCP server's `files`; orca-design publish-cli, D5.7, amended 2026-10-12).
// Each file is uploaded to /v1/files, then named in the sandbox's
// environment by file_id: in the create body for a new sandbox, or through
// the environment's files route for one that exists or comes from a
// template, whose own files a create-time list would replace.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type OpenAI from 'openai'

import { CliError, ExitCode } from './errors.js'
import { uploadFile } from './transfer.js'

// The server's staging limits: one file (FILE_LIMIT in
// src/environments/configuration.rs) and every file of one sandbox together
// (STAGING_LIMIT in src/environments/staging.rs).
export const FILE_LIMIT = 16 * 1024 * 1024
export const STAGING_LIMIT = 64 * 1024 * 1024

const WORKSPACE = '/workspace'

export type FileSpec = { path: string; dest?: string }

// A file checked and ready to upload: where it is, where it goes, its size.
export type StagedFile = { local: string; dest: string; bytes: number }

// An uploaded file and where it goes in the sandbox.
export type StagedUpload = { file_id: string; dest: string }

const mib = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`

const isFile = async (p: string) => (await fs.stat(p).catch(() => null))?.isFile() ?? false

// parseFileFlag reads `--file <path>[:<dest>]`. The text after the last
// colon is the destination when the text before it is a file on this
// machine; otherwise the whole value is the path, so a Windows drive letter
// or a name with a colon still works.
export async function parseFileFlag(value: string): Promise<FileSpec> {
  const colon = value.lastIndexOf(':')
  if (colon > 0 && colon < value.length - 1 && (await isFile(value.slice(0, colon)))) {
    return { path: value.slice(0, colon), dest: value.slice(colon + 1) }
  }
  return { path: value }
}

// destination is where a file lands: /workspace/<its name> by default, and
// a relative destination is under /workspace. The server checks it stays
// inside the workspace.
function destination(spec: FileSpec): string {
  const dest = spec.dest?.trim() || path.basename(spec.path)
  return dest.startsWith('/') ? dest : path.posix.join(WORKSPACE, dest)
}

// prepareFiles checks every file before anything is uploaded: each must be
// a file, within the server's limit for one, and all within the limit
// together, with no two at one destination.
export async function prepareFiles(specs: readonly FileSpec[]): Promise<StagedFile[]> {
  const files: StagedFile[] = []
  for (const spec of specs) {
    const stat = await fs.stat(spec.path).catch(() => null)
    if (!stat || !stat.isFile()) throw new CliError(`--file: not a file: ${spec.path}`, ExitCode.Usage)
    if (stat.size > FILE_LIMIT) {
      throw new CliError(
        `--file: ${spec.path} is ${mib(stat.size)}; a staged file can be at most ${mib(FILE_LIMIT)}`,
        ExitCode.Usage,
      )
    }
    const dest = destination(spec)
    if (files.some((f) => f.dest === dest)) throw new CliError(`--file: two files go to ${dest}`, ExitCode.Usage)
    files.push({ local: spec.path, dest, bytes: stat.size })
  }
  const total = files.reduce((sum, f) => sum + f.bytes, 0)
  if (total > STAGING_LIMIT) {
    throw new CliError(
      `--file: the files come to ${mib(total)}; a sandbox's staged files can be at most ${mib(STAGING_LIMIT)} together`,
      ExitCode.Usage,
    )
  }
  return files
}

// uploadStaged uploads each file in turn. If one fails, the ones already
// uploaded are deleted before the error is raised.
export async function uploadStaged(client: OpenAI, files: readonly StagedFile[]): Promise<StagedUpload[]> {
  const uploads: StagedUpload[] = []
  try {
    for (const file of files) {
      uploads.push({ file_id: (await uploadFile(client, file.local)).id, dest: file.dest })
    }
  } catch (err) {
    await deleteUploads(client, uploads)
    throw err
  }
  return uploads
}

// deleteUploads removes files this command uploaded and did not stage.
// Best effort: the error that led here is the one reported.
export async function deleteUploads(client: OpenAI, uploads: readonly StagedUpload[]): Promise<void> {
  await Promise.all(uploads.map((u) => client.files.delete(u.file_id).catch(() => undefined)))
}

// environmentFiles is the create body's `environment.files` for uploads.
export function environmentFiles(uploads: readonly StagedUpload[]) {
  return uploads.map((u) => ({ type: 'file_id' as const, file_id: u.file_id, path: u.dest }))
}

// writeToEnvironment stages uploads into a sandbox that exists, through
// POST /v1/agents/environments/{id}/files.
export async function writeToEnvironment(
  client: OpenAI,
  environmentId: string,
  uploads: readonly StagedUpload[],
): Promise<void> {
  for (const file of environmentFiles(uploads)) {
    await client.beta.agents.environments.files.create(environmentId, file)
  }
}

// stageIntoSession stages files into an existing session's sandbox. A
// session with no managed sandbox is refused before anything is uploaded.
export async function stageIntoSession(client: OpenAI, sessionId: string, files: readonly StagedFile[]): Promise<void> {
  if (files.length === 0) return
  const session = await client.beta.agents.sessions.retrieve(sessionId)
  if (session.environment.type !== 'openai_hosted') {
    throw new CliError(`--file: session ${sessionId} has no sandbox to stage files into`, ExitCode.Usage, [
      'Start a new session with --file instead.',
    ])
  }
  const uploads = await uploadStaged(client, files)
  try {
    await writeToEnvironment(client, session.environment.id, uploads)
  } catch (err) {
    await deleteUploads(client, uploads)
    throw err
  }
}

// stagedNote names each staged file and where it went, for stderr.
export function stagedNote(files: readonly StagedFile[]): string[] {
  return files.map((f) => `Staged ${path.basename(f.local)} at ${f.dest}.`)
}
