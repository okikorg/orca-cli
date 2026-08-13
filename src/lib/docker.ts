// Docker mechanics for the harness workflow: build an image, push it, and
// resolve the digest the platform needs.
//
// Every call shells out to the user's own docker. The CLI never handles
// registry credentials: `docker login` is the user's, and when a push is
// refused we surface docker's own error rather than trying to authenticate.
//
// The functions take an exec function so tests can assert the argv without
// docker installed. Nothing here parses docker's human-readable output except
// resolveDigest, which reads a --format template it controls.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// The platform's import policy checks for linux/amd64, and sessions boot on
// amd64 substrates. A build on Apple Silicon defaults to arm64, which would
// import to "ready" and then fail at first boot, so the default is pinned
// here rather than inherited from the builder's host.
export const DEFAULT_PLATFORM = 'linux/amd64'

export type ExecResult = { stdout: string; stderr: string }
export type Exec = (file: string, args: string[]) => Promise<ExecResult>

// Streaming exec for the long commands (build, push), where the user wants
// docker's progress on their terminal rather than a silent wait.
export type ExecStreaming = (file: string, args: string[]) => Promise<void>

export const defaultExec: Exec = async (file, args) => {
  const { stdout, stderr } = await execFileP(file, args, { maxBuffer: 32 * 1024 * 1024 })
  return { stdout: String(stdout), stderr: String(stderr) }
}

export const defaultExecStreaming: ExecStreaming = (file, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 32 * 1024 * 1024 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
    child.stdout?.pipe(process.stderr)
    child.stderr?.pipe(process.stderr)
  })

export class DockerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DockerError'
  }
}

// dockerAvailable reports whether a docker CLI answers at all. Called before
// a build so the failure is "docker is not installed" rather than ENOENT
// surfacing from the middle of a build.
export async function dockerAvailable(exec: Exec = defaultExec): Promise<boolean> {
  try {
    await exec('docker', ['version', '--format', '{{.Client.Version}}'])
    return true
  } catch {
    return false
  }
}

export type BuildOptions = {
  context: string
  tag: string
  platform?: string
  file?: string
  noCache?: boolean
}

export function buildArgs(opts: BuildOptions): string[] {
  const args = ['build', '--platform', opts.platform ?? DEFAULT_PLATFORM, '-t', opts.tag]
  if (opts.file) args.push('-f', opts.file)
  if (opts.noCache) args.push('--no-cache')
  args.push(opts.context)
  return args
}

export async function build(
  opts: BuildOptions,
  exec: ExecStreaming = defaultExecStreaming,
): Promise<void> {
  try {
    await exec('docker', buildArgs(opts))
  } catch (err) {
    throw new DockerError(`docker build failed: ${errText(err)}`)
  }
}

export async function push(tag: string, exec: ExecStreaming = defaultExecStreaming): Promise<void> {
  try {
    await exec('docker', ['push', tag])
  } catch (err) {
    throw new DockerError(`docker push failed: ${errText(err)}`)
  }
}

// resolveDigest returns the repository@sha256:... reference for a pushed tag.
//
// A repo digest only exists after a push: it is the digest the registry
// assigned, not the local image id. RepoDigests can hold entries for several
// repositories once an image has been tagged and pushed more than once, so
// the entry is matched against the target repository rather than taken at
// index 0.
export async function resolveDigest(tag: string, exec: Exec = defaultExec): Promise<string> {
  const repo = repositoryOf(tag)
  let out: string
  try {
    const res = await exec('docker', [
      'image',
      'inspect',
      tag,
      '--format',
      '{{join .RepoDigests "\\n"}}',
    ])
    out = res.stdout
  } catch (err) {
    throw new DockerError(`could not inspect ${tag}: ${errText(err)}`)
  }

  const digests = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const match = digests.find((d) => repositoryOf(d) === repo)
  if (!match) {
    throw new DockerError(
      digests.length === 0
        ? `${tag} has no repository digest yet, which means it has not been pushed`
        : `${tag} has no repository digest for ${repo} (found: ${digests.join(', ')})`,
    )
  }
  return match
}

// repositoryOf strips the tag or digest from a reference, leaving the
// repository. A registry host may carry a port (localhost:5000/x), so the
// colon that starts a tag is only the one after the last slash.
export function repositoryOf(ref: string): string {
  const at = ref.indexOf('@')
  const base = at === -1 ? ref : ref.slice(0, at)
  const slash = base.lastIndexOf('/')
  const colon = base.indexOf(':', slash + 1)
  return colon === -1 ? base : base.slice(0, colon)
}

function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string; code?: string }
    if (e.code === 'ENOENT') return 'docker is not installed or not on PATH'
    const stderr = e.stderr?.trim()
    if (stderr) return stderr
    if (e.message) return e.message
  }
  return String(err)
}
