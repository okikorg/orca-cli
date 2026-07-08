// Release discovery + self-update mechanics for the standalone binary.
//
// The CLI ships as Bun-compiled binaries published to GitHub Releases on the
// public repo below (tags `cli-v<semver>`, assets `orca-<os>-<arch>.tar.gz`
// plus a SHA256SUMS manifest — see scripts/build-binary.ts and
// scripts/package-binaries.sh). `orca update` downloads the matching asset,
// verifies its checksum, and atomically swaps it over the running executable.
// The `-v` update hint (lib/update-check.ts) reuses fetchLatestRelease.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { IS_STANDALONE } from '../version.js'

const execFileP = promisify(execFile)

// The public repo that hosts the release binaries; install.sh points at the
// same one. Keep these three in sync with the install script and README.
export const RELEASE_REPO = 'okikorg/orca-cli'
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`
export const INSTALL_SCRIPT_URL = 'https://orca-landing-woad.vercel.app/install.sh'
export const NPM_PACKAGE = '@agent-orc/cli'

// Release tags are `cli-v<semver>`; the VERSION constant is the bare semver.
export const TAG_PREFIX = 'cli-v'

const GITHUB_API = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 10_000

export type ReleaseAsset = { name: string; url: string }

export type ReleaseInfo = {
  tag: string
  version: string
  assets: ReleaseAsset[]
  htmlUrl: string
  publishedAt?: string
}

export type UpdateCheck = {
  current: string
  currentTag: string
  latest: string
  latestTag: string
  updateAvailable: boolean
  htmlUrl: string
}

// -- version arithmetic (pure) ----------------------------------------------

// Strips a leading `cli-v` release tag or bare `v` so `cli-v0.2.0`, `v0.2.0`,
// and `0.2.0` all normalize to `0.2.0`.
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^cli-v/i, '').replace(/^v/i, '')
}

// Renders the release-tag form of a version: `0.2.0` -> `cli-v0.2.0`.
export function tagFor(version: string): string {
  return `${TAG_PREFIX}${normalizeVersion(version)}`
}

// Compares two versions numerically segment by segment. Returns 1 if a > b,
// -1 if a < b, 0 if equal. A prerelease suffix (after `-`) orders below the
// same release version, then compares lexically. Sufficient for cli-vX.Y.Z.
export function compareSemver(a: string, b: string): number {
  const [aCore, aPre = ''] = normalizeVersion(a).split('-', 2)
  const [bCore, bPre = ''] = normalizeVersion(b).split('-', 2)
  const ap = aCore.split('.').map((n) => parseInt(n, 10) || 0)
  const bp = bCore.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(ap.length, bp.length)
  for (let i = 0; i < len; i++) {
    const d = (ap[i] ?? 0) - (bp[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  if (aPre === bPre) return 0
  if (!aPre) return 1 // 1.0.0 > 1.0.0-rc1
  if (!bPre) return -1
  return aPre < bPre ? -1 : 1
}

// Maps a Node platform/arch pair to the release asset name emitted by
// scripts/build-binary.ts. Throws for a target we don't publish. Windows only
// ships an x64 build, so any Windows arch maps to it.
export function assetNameFor(platform: NodeJS.Platform, arch: string): string {
  const os =
    platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : null
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (!os) throw new Error(`no prebuilt orca binary for platform ${platform}`)
  if (os === 'windows') return 'orca-windows-x64.tar.gz'
  if (!cpu) throw new Error(`no prebuilt orca binary for ${platform}/${arch}`)
  return `orca-${os}-${cpu}.tar.gz`
}

// Extracts the expected hex digest for `assetName` from a SHA256SUMS manifest
// (`<hex>  <filename>` lines, as written by sha256sum / shasum -a 256; the
// optional `*` binary marker is tolerated).
export function parseSha256Sums(text: string, assetName: string): string | null {
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (m && m[2].trim() === assetName) return m[1].toLowerCase()
  }
  return null
}

// -- GitHub release fetch ----------------------------------------------------

type GithubRelease = {
  tag_name?: string
  html_url?: string
  published_at?: string
  assets?: { name?: string; browser_download_url?: string }[]
}

// Normalizes a GitHub release payload into ReleaseInfo. Throws when the shape
// is unrecognizable (e.g. a rate-limit error object with no tag_name).
export function parseRelease(json: unknown): ReleaseInfo {
  const r = json as GithubRelease
  if (!r || typeof r.tag_name !== 'string') {
    throw new Error('unexpected GitHub release payload (missing tag_name)')
  }
  const assets: ReleaseAsset[] = (r.assets ?? [])
    .filter(
      (a): a is { name: string; browser_download_url: string } =>
        typeof a?.name === 'string' && typeof a?.browser_download_url === 'string',
    )
    .map((a) => ({ name: a.name, url: a.browser_download_url }))
  return {
    tag: r.tag_name,
    version: normalizeVersion(r.tag_name),
    assets,
    htmlUrl: typeof r.html_url === 'string' ? r.html_url : RELEASES_URL,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : undefined,
  }
}

export type FetchOpts = { timeoutMs?: number; fetchImpl?: typeof fetch }

async function githubJson(url: string, opts: FetchOpts): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    // GitHub rejects API requests without a User-Agent.
    'User-Agent': 'orca-cli',
  }
  // A token (if the user has one) lifts the low anonymous rate limit; optional.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`)
  return res.json()
}

export async function fetchLatestRelease(opts: FetchOpts = {}): Promise<ReleaseInfo> {
  return parseRelease(await githubJson(`${GITHUB_API}/repos/${RELEASE_REPO}/releases/latest`, opts))
}

export async function fetchReleaseByTag(tag: string, opts: FetchOpts = {}): Promise<ReleaseInfo> {
  const full = tag.startsWith(TAG_PREFIX) ? tag : tagFor(tag)
  return parseRelease(
    await githubJson(`${GITHUB_API}/repos/${RELEASE_REPO}/releases/tags/${encodeURIComponent(full)}`, opts),
  )
}

// Builds the current-vs-release comparison used by both `update` and the
// `-v` hint.
export function summarizeCheck(current: string, release: ReleaseInfo): UpdateCheck {
  return {
    current: normalizeVersion(current),
    currentTag: tagFor(current),
    latest: release.version,
    latestTag: release.tag,
    updateAvailable: compareSemver(release.version, current) > 0,
    htmlUrl: release.htmlUrl,
  }
}

// Best-effort check for the `-v` hint: swallows every failure (offline,
// rate-limited, malformed) and returns null so printing the version is never
// blocked.
export async function checkForUpdate(current: string, opts: FetchOpts = {}): Promise<UpdateCheck | null> {
  try {
    return summarizeCheck(current, await fetchLatestRelease(opts))
  } catch {
    return null
  }
}

// -- in-place binary update --------------------------------------------------

export type UpdateEnv = {
  standalone: boolean
  platform: NodeJS.Platform
  arch: string
  execPath: string
}

// Runtime facts the update command needs, gathered in one place so tests can
// substitute a fabricated environment.
export function currentEnv(): UpdateEnv {
  return {
    standalone: IS_STANDALONE,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
  }
}

export type UpdateHooks = { fetchImpl?: typeof fetch; onProgress?: (msg: string) => void }

// Downloads the release asset for env's platform, verifies its SHA-256 against
// the release's SHA256SUMS manifest, and atomically swaps it over the running
// executable. Returns the installed path. Unix only — the caller must exclude
// Windows (a running .exe cannot replace itself). Staging happens inside the
// executable's own directory so the final rename is same-filesystem (atomic)
// and works even while the old binary is still running.
export async function performBinaryUpdate(
  release: ReleaseInfo,
  env: UpdateEnv,
  hooks: UpdateHooks = {},
): Promise<{ path: string; version: string }> {
  const fetchImpl = hooks.fetchImpl ?? fetch
  const progress = hooks.onProgress ?? (() => {})

  const assetName = assetNameFor(env.platform, env.arch)
  const asset = release.assets.find((a) => a.name === assetName)
  if (!asset) throw new Error(`release ${release.tag} has no asset ${assetName}`)
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS')
  if (!sums) throw new Error(`release ${release.tag} has no SHA256SUMS manifest`)

  const execDir = path.dirname(env.execPath)
  const stageDir = path.join(execDir, `.orca-update-${process.pid}`)
  await fs.mkdir(stageDir, { recursive: true })
  try {
    progress(`downloading ${assetName}`)
    const tarball = path.join(stageDir, assetName)
    await downloadToFile(asset.url, tarball, fetchImpl)

    progress('verifying checksum')
    const expected = parseSha256Sums(await fetchText(sums.url, fetchImpl), assetName)
    if (!expected) throw new Error(`SHA256SUMS has no entry for ${assetName}`)
    const actual = await sha256File(tarball)
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`)
    }

    progress('extracting')
    // Each tarball holds a single `orca` executable (see package-binaries.sh).
    await execFileP('tar', ['-xzf', tarball, '-C', stageDir])
    const extracted = path.join(stageDir, 'orca')
    await fs.access(extracted)

    await fs.chmod(extracted, await currentMode(env.execPath))
    progress(`installing to ${env.execPath}`)
    await fs.rename(extracted, env.execPath)

    return { path: env.execPath, version: release.version }
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true })
  }
}

async function downloadToFile(url: string, dest: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  return res.text()
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

// The mode to stamp onto the new binary: preserve the existing one, defaulting
// to 0755 if it can't be read.
async function currentMode(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mode & 0o777
  } catch {
    return 0o755
  }
}
