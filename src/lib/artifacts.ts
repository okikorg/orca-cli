// A session's artifacts (orca-design publish-cli, D5.7, amended 2026-10-12):
// immutable copies of the files an agent saved under <workspace>/outputs,
// taken when a turn completes. Every completed turn copies the whole folder,
// so the newest turn's artifacts are the folder as it stands. `orca
// sessions artifacts` and the MCP server share these.

import { promises as fs } from 'node:fs'

import type OpenAI from 'openai'
import type { SessionArtifact } from 'openai/resources/beta/agents/sessions/artifacts'

import { CliError, ExitCode } from './errors.js'
import { inFolder, remoteName, saveBody, TRANSFER_TIMEOUT_MS } from './transfer.js'

export type SavedArtifact = { id: string; path: string; bytes: number }

const NONE_HINT = 'Only files saved under /workspace/outputs are kept, when a turn completes.'

// allArtifacts reads every artifact of a session, newest first.
export async function allArtifacts(client: OpenAI, sessionId: string): Promise<SessionArtifact[]> {
  const rows: SessionArtifact[] = []
  for await (const row of client.beta.agents.sessions.artifacts.list(sessionId, { limit: 100, order: 'desc' })) {
    rows.push(row)
  }
  return rows
}

function noArtifacts(sessionId: string): CliError {
  return new CliError(`session ${sessionId} has no artifacts`, ExitCode.Failure, [NONE_HINT])
}

// newestTurn is the newest turn's artifacts, from a newest-first list.
export function newestTurn(sessionId: string, rows: readonly SessionArtifact[]): SessionArtifact[] {
  const turn = rows[0]?.turn_id
  if (!turn) throw noArtifacts(sessionId)
  return rows.filter((row) => row.turn_id === turn)
}

// findArtifact resolves an artifact id, or a path as the listing shows it,
// which takes the newest artifact at that path.
export async function findArtifact(client: OpenAI, sessionId: string, ref: string): Promise<SessionArtifact> {
  if (!ref.includes('/')) return client.beta.agents.sessions.artifacts.retrieve(ref, { session_id: sessionId })
  const rows = await allArtifacts(client, sessionId)
  const found = rows.find((row) => row.path === ref)
  if (!found) {
    throw new CliError(`no artifact at ${ref} in session ${sessionId}`, ExitCode.NotFound, [
      `List them: orca sessions artifacts ${sessionId}`,
    ])
  }
  return found
}

// plannedPaths names where each artifact of an --all download goes: its
// file name in the folder. Two with one name are refused before anything
// is written.
export function plannedPaths(rows: readonly SessionArtifact[], folder: string): Map<SessionArtifact, string> {
  const planned = new Map<SessionArtifact, string>()
  const byDest = new Map<string, SessionArtifact>()
  for (const row of rows) {
    const dest = inFolder(folder, row.path)
    const other = byDest.get(dest)
    if (other) {
      throw new CliError(`two artifacts would both be saved as ${remoteName(row.path)}`, ExitCode.Failure, [
        other.path,
        row.path,
        'Download them one at a time with -o.',
      ])
    }
    byDest.set(dest, row)
    planned.set(row, dest)
  }
  return planned
}

// saveArtifact streams one artifact's bytes to a file, or stdout for `-`.
export async function saveArtifact(client: OpenAI, artifact: SessionArtifact, dest: string): Promise<SavedArtifact> {
  const res = await client.beta.agents.sessions.artifacts.content(
    artifact.id,
    { session_id: artifact.session_id },
    { timeout: TRANSFER_TIMEOUT_MS },
  )
  await saveBody(res, dest, `artifact ${artifact.id}`)
  const bytes = dest === '-' ? artifact.size_bytes : (await fs.stat(dest)).size
  return { id: artifact.id, path: dest, bytes }
}

// oneDestination is where a single artifact goes: -o as given, inside it
// when it is a folder, else its file name in the current folder.
export async function oneDestination(artifact: SessionArtifact, output?: string): Promise<string> {
  if (output === '-') return output
  if (output === undefined) return inFolder('.', artifact.path)
  const stat = await fs.stat(output).catch(() => null)
  return stat?.isDirectory() ? inFolder(output, artifact.path) : output
}

// saveNewestTurn downloads every artifact of the newest turn into a folder,
// created if missing.
export async function saveNewestTurn(client: OpenAI, sessionId: string, folder: string): Promise<SavedArtifact[]> {
  const planned = plannedPaths(newestTurn(sessionId, await allArtifacts(client, sessionId)), folder)
  await fs.mkdir(folder, { recursive: true })
  const saved: SavedArtifact[] = []
  for (const [artifact, dest] of planned) saved.push(await saveArtifact(client, artifact, dest))
  return saved
}
