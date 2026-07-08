// Powers the `orca -v` update hint. Prints a single stderr line when a newer
// release exists, backed by a ~24h on-disk cache so the common `orca -v` stays
// instant and offline-safe and the GitHub API is never hammered. The whole
// path is best-effort: disabled by ORCA_NO_UPDATE_CHECK, skipped when stderr
// is not a TTY (scripts/CI), and it never throws or blocks the version output.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { hintText } from '../ui/theme.js'
import { configDir } from './config.js'
import { checkForUpdate, compareSemver } from './release.js'

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000

// Short timeout: `-v` should not stall on a slow network.
const CHECK_TIMEOUT_MS = 2_000

type Cache = { checkedAt: number; latestTag: string; latest: string }

function cachePath(): string {
  return path.join(configDir(), 'update-check.json')
}

async function readCache(): Promise<Cache | null> {
  try {
    const c = JSON.parse(await fs.readFile(cachePath(), 'utf8')) as Cache
    if (typeof c?.latest === 'string' && typeof c?.checkedAt === 'number') return c
    return null
  } catch {
    return null
  }
}

async function writeCache(c: Cache): Promise<void> {
  try {
    await fs.mkdir(configDir(), { recursive: true, mode: 0o700 })
    await fs.writeFile(cachePath(), JSON.stringify(c) + '\n')
  } catch {
    // A read-only home or a lost race is not worth surfacing on a `-v` hint.
  }
}

export type NotifyOpts = {
  now?: number
  timeoutMs?: number
  isTty?: boolean
  emit?: (line: string) => void
}

// notifyIfUpdateAvailable is the `-v` hook. It uses a fresh cache when one
// exists (< TTL), otherwise refreshes it with a short-timeout live check;
// either way it falls back to a stale cached value so offline users still see
// the hint. Prints nothing when up to date, disabled, or non-interactive.
export async function notifyIfUpdateAvailable(current: string, opts: NotifyOpts = {}): Promise<void> {
  const isTty = opts.isTty ?? Boolean(process.stderr.isTTY)
  if (process.env.ORCA_NO_UPDATE_CHECK || !isTty) return

  const now = opts.now ?? Date.now()
  try {
    const cache = await readCache()
    let latest = cache?.latest ?? null
    let latestTag = cache?.latestTag ?? null

    const fresh = cache != null && now - cache.checkedAt < UPDATE_CHECK_TTL_MS
    if (!fresh) {
      const check = await checkForUpdate(current, { timeoutMs: opts.timeoutMs ?? CHECK_TIMEOUT_MS })
      if (check) {
        latest = check.latest
        latestTag = check.latestTag
        await writeCache({ checkedAt: now, latestTag: check.latestTag, latest: check.latest })
      }
      // On a failed refresh, fall through to whatever the (stale) cache held.
    }

    if (latest && latestTag && compareSemver(latest, current) > 0) {
      const emit = opts.emit ?? ((line: string) => console.error(hintText(line)))
      emit(`\nA newer version (${latestTag}) is available. Run: orca update`)
    }
  } catch {
    // Never let the update check interfere with printing the version.
  }
}
