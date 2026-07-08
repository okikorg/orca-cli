import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import { outputMode, printJson } from '../lib/output.js'
import {
  currentEnv,
  fetchLatestRelease,
  fetchReleaseByTag,
  INSTALL_SCRIPT_URL,
  NPM_PACKAGE,
  performBinaryUpdate,
  RELEASES_URL,
  summarizeCheck,
  type ReleaseInfo,
  type UpdateEnv,
} from '../lib/release.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { VERSION } from '../version.js'
import { globalFlags } from './shared.js'

// Injectable seam: the action reads its network/filesystem/environment work
// through these so tests can drive every branch without real releases, tar, or
// touching the running binary. cli.ts registers with the real implementations.
export type UpdateDeps = {
  env: () => UpdateEnv
  fetchLatest: (opts?: { timeoutMs?: number }) => Promise<ReleaseInfo>
  fetchByTag: (tag: string) => Promise<ReleaseInfo>
  performUpdate: typeof performBinaryUpdate
}

const realDeps: UpdateDeps = {
  env: currentEnv,
  fetchLatest: fetchLatestRelease,
  fetchByTag: fetchReleaseByTag,
  performUpdate: performBinaryUpdate,
}

export function registerUpdate(program: Command, deps: UpdateDeps = realDeps): void {
  program
    .command('update')
    .description('update the orca CLI to the latest release')
    .option('--check', "report whether a newer version exists, but don't install it")
    .option('--force', 'reinstall the target version even if it matches the current one')
    .option('--tag <version>', 'install a specific version (e.g. cli-v0.1.0 or 0.1.0)')
    .action(async (opts: { check?: boolean; force?: boolean; tag?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const json = outputMode(flags) === 'json'
      const env = deps.env()

      // Resolve the target release: a pinned tag, or the latest.
      let release: ReleaseInfo
      try {
        release = opts.tag ? await deps.fetchByTag(opts.tag) : await deps.fetchLatest()
      } catch (err) {
        const what = opts.tag ? `release ${opts.tag}` : 'the latest release'
        throw new CliError(
          `could not fetch ${what}: ${err instanceof Error ? err.message : String(err)}`,
          ExitCode.Failure,
          [`Browse releases at ${RELEASES_URL}`],
        )
      }

      const check = summarizeCheck(VERSION, release)

      // --check: report and stop.
      if (opts.check) {
        if (json) {
          printJson(check)
        } else if (check.updateAvailable) {
          console.log(`${accentVerb('Update available')}: ${check.currentTag} -> ${check.latestTag}`)
          console.error(hintText('Run `orca update` to install it.'))
        } else {
          console.log(`Up to date (${check.currentTag}).`)
        }
        return
      }

      // Already current, and not forced: nothing to do.
      if (!check.updateAvailable && !opts.force) {
        if (json) printJson({ ...check, updated: false })
        else console.log(`Already on the latest version (${check.currentTag}).`)
        return
      }

      // Only a standalone binary can rewrite itself. npm/dev installs and
      // Windows (a running .exe can't replace itself) get guidance instead.
      const guidance = updateGuidance(env)
      if (guidance) {
        if (json) {
          printJson({ ...check, updated: false, reason: guidance.reason })
        } else {
          console.log(guidance.message)
          for (const line of guidance.hints) console.error(hintText(line))
        }
        return
      }

      if (!json) console.error(hintText(`Updating ${check.currentTag} -> ${check.latestTag} ...`))
      let installed: { path: string; version: string }
      try {
        installed = await deps.performUpdate(release, env, {
          onProgress: json ? undefined : (m) => console.error(hintText(`  ${m}`)),
        })
      } catch (err) {
        throw mapUpdateError(err, env)
      }

      if (json) printJson({ ...check, updated: true, path: installed.path })
      else console.log(`${accentVerb('Updated')} to ${release.tag} (${installed.path}).`)
    })
}

type Guidance = { reason: string; message: string; hints: string[] }

// Explains why an in-place update can't run, with the right manual path.
// Returns null when a self-update is possible.
function updateGuidance(env: UpdateEnv): Guidance | null {
  if (env.platform === 'win32') {
    return {
      reason: 'windows',
      message: 'Automatic update is not supported on Windows (a running .exe cannot replace itself).',
      hints: [`Download orca-windows-x64.tar.gz from ${RELEASES_URL}`],
    }
  }
  if (!env.standalone) {
    return {
      reason: 'not-standalone',
      message: "This orca wasn't installed as a standalone binary, so it can't self-update.",
      hints: [
        `If you installed via npm:  npm install -g ${NPM_PACKAGE}@latest`,
        `Or (re)install the binary:  curl -fsSL ${INSTALL_SCRIPT_URL} | sh`,
      ],
    }
  }
  return null
}

// Turns a raw filesystem/tar failure into a CliError with an actionable hint.
function mapUpdateError(err: unknown, env: UpdateEnv): CliError {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') {
    return new CliError(`cannot write to ${env.execPath}: permission denied`, ExitCode.Failure, [
      'The install directory is not writable by your user.',
      `Re-run with elevated permissions, or reinstall: curl -fsSL ${INSTALL_SCRIPT_URL} | sh`,
    ])
  }
  if (code === 'ENOENT' && /\btar\b/.test(msg)) {
    return new CliError('`tar` is required to unpack the update but was not found on PATH.', ExitCode.Failure)
  }
  return new CliError(`update failed: ${msg}`, ExitCode.Failure)
}
