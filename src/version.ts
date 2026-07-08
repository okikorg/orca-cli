import { createRequire } from 'node:module'

// Injected at build time by the standalone-binary build (Bun `--define`).
// Undefined in dev (tsx) and in the tsup/npm build, where we read package.json
// off disk instead. `typeof` on an undeclared identifier is safe and never
// throws, so this reference is valid in every build mode.
declare const __ORCA_VERSION__: string | undefined
const injected =
  typeof __ORCA_VERSION__ !== 'undefined' ? __ORCA_VERSION__ : ''

function versionFromPackageJson(): string {
  try {
    // package.json sits one level above both src/ (dev via tsx) and dist/
    // (built via tsup), so the same relative path works in either mode.
    const pkg = createRequire(import.meta.url)('../package.json') as {
      version: string
    }
    return pkg.version
  } catch {
    // A compiled binary has no package.json on disk; the injected value above
    // covers that case, so this fallback only trips in an unexpected build.
    return '0.0.0-unknown'
  }
}

export const VERSION = injected || versionFromPackageJson()

// True only inside a Bun-compiled standalone binary, where the version was
// injected at build time. Node/tsup and dev (tsx) runs read package.json off
// disk instead and report false. `orca update` consults this to decide whether
// it can rewrite its own executable in place.
export const IS_STANDALONE = Boolean(injected)
