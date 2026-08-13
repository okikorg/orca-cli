// The authoring side of bring-your-own-agent: scaffold a harness, build it,
// and get it running on the platform.
//
// `orca templates` manages versions that already exist in a registry. This
// group is what produces them. The gap it closes is the digest: a template
// version must be digest-pinned, but a repository digest only exists after a
// push, so getting one by hand means a build, a push, and a docker inspect
// whose --format template nobody remembers.
//
// Nothing here handles registry credentials. `docker login` is the user's,
// and when docker refuses we print its error and stop.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { Command } from 'commander'

import { ApiError } from '../lib/api.js'
import {
  build as dockerBuild,
  DEFAULT_PLATFORM,
  dockerAvailable,
  DockerError,
  push as dockerPush,
  resolveDigest,
} from '../lib/docker.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { SCAFFOLD_FILES } from '../lib/harness-scaffold.js'
import { outputMode, printJson } from '../lib/output.js'
import type { TemplateVersion } from '../lib/types.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { apiContext, type ApiContext, globalFlags, withApi } from './shared.js'
import { waitForVersion } from './templates.js'

// A tag for a build that is about to be pushed and then referenced by digest.
// The tag itself is never what the platform records, so its only job is to
// name the push; it is dated rather than "latest" so a registry's tag list
// stays readable.
function defaultTag(): string {
  return `build-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
}

async function ensureBuildContext(dir: string): Promise<void> {
  const stat = await fs.stat(dir).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new CliError(`not a directory: ${dir}`, ExitCode.Usage)
  }
  const hasDockerfile = await fs
    .stat(path.join(dir, 'Dockerfile'))
    .then((s) => s.isFile())
    .catch(() => false)
  if (!hasDockerfile) {
    throw new CliError(`no Dockerfile in ${dir}`, ExitCode.Usage, [
      'A harness is deployed as a container image, so the build context needs',
      'a Dockerfile. Scaffold one with: orca harness init',
    ])
  }
}

async function requireDocker(): Promise<void> {
  if (!(await dockerAvailable())) {
    throw new CliError('docker is not installed or not running', ExitCode.Failure, [
      'The harness build and deploy commands shell out to your own docker.',
    ])
  }
}

// Everything docker tells us is already the user's own error text; wrap it in
// the exit-code contract without editorialising.
function asCliError(err: unknown): CliError {
  if (err instanceof CliError) return err
  if (err instanceof DockerError) return new CliError(err.message, ExitCode.Failure)
  return err instanceof Error
    ? new CliError(err.message, ExitCode.Failure)
    : new CliError(String(err), ExitCode.Failure)
}

export function registerHarness(program: Command): void {
  const harness = program
    .command('harness')
    .description('scaffold, build, and deploy your own agent harness')

  harness
    .command('init [dir]')
    .description('write a working Harness Protocol v1 harness into a directory')
    .option('--force', 'overwrite files that already exist')
    .action(async (dirArg: string | undefined, opts: { force?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const dir = path.resolve(dirArg ?? '.')
      await fs.mkdir(dir, { recursive: true })

      // Refuse as a set rather than half-writing: a scaffold that overwrote
      // server.js and stopped at the Dockerfile leaves no good next move.
      if (!opts.force) {
        const clashes: string[] = []
        for (const f of SCAFFOLD_FILES) {
          const exists = await fs
            .stat(path.join(dir, f.path))
            .then(() => true)
            .catch(() => false)
          if (exists) clashes.push(f.path)
        }
        if (clashes.length > 0) {
          throw new CliError(
            `${clashes.join(', ')} already exist${clashes.length === 1 ? 's' : ''} in ${dir}`,
            ExitCode.Usage,
            ['Re-run with --force to overwrite, or pick an empty directory.'],
          )
        }
      }

      for (const f of SCAFFOLD_FILES) {
        await fs.writeFile(path.join(dir, f.path), f.content, { mode: f.mode })
      }

      if (outputMode(flags) === 'json') {
        printJson({ dir, files: SCAFFOLD_FILES.map((f) => f.path) })
        return
      }
      console.log(`${accentVerb('Created')} a harness in ${dir}.`)
      console.error(hintText('  your agent goes in runAgent() in server.js'))
      console.error(hintText('  run it:    PORT=7099 node server.js'))
      console.error(hintText('  ship it:   orca harness deploy <name> . --image <registry>/<repo>'))
    })

  harness
    .command('build [dir]')
    .description('build the harness image for the platform architecture')
    .requiredOption('--image <repo>', 'target repository, e.g. ghcr.io/acme/my-harness')
    .option('--tag <tag>', 'image tag (default: build-YYYYMMDD)')
    .option('--platform <platform>', 'build platform', DEFAULT_PLATFORM)
    .option('--file <path>', 'Dockerfile path (default: <dir>/Dockerfile)')
    .option('--no-cache', 'build without the layer cache')
    .action(
      async (
        dirArg: string | undefined,
        opts: { image: string; tag?: string; platform: string; file?: string; cache: boolean },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const dir = path.resolve(dirArg ?? '.')
        await ensureBuildContext(dir)
        await requireDocker()

        const tag = `${opts.image}:${opts.tag ?? defaultTag()}`
        try {
          await dockerBuild({
            context: dir,
            tag,
            platform: opts.platform,
            file: opts.file,
            noCache: !opts.cache,
          })
        } catch (err) {
          throw asCliError(err)
        }

        if (outputMode(flags) === 'json') {
          printJson({ image: tag, platform: opts.platform })
          return
        }
        console.log(`${accentVerb('Built')} ${tag} for ${opts.platform}.`)
        // Say why this cannot be imported yet. A local build has an image id,
        // not a repository digest, and only a digest is a template version.
        console.error(
          hintText('  a local build has no repository digest, so it cannot be imported yet'),
        )
        console.error(hintText(`  push and import in one step: orca harness deploy <name> ${dirArg ?? '.'} --image ${opts.image}`))
      },
    )

  harness
    .command('deploy <name> [dir]')
    .description(
      'build, push, import, and activate a harness in one step ' +
        '(creates the template if it does not exist; the image must be pullable without credentials)',
    )
    .requiredOption('--image <repo>', 'target repository, e.g. ghcr.io/acme/my-harness')
    .option('--tag <tag>', 'image tag (default: build-YYYYMMDD)')
    .option('--platform <platform>', 'build platform', DEFAULT_PLATFORM)
    .option('--file <path>', 'Dockerfile path (default: <dir>/Dockerfile)')
    .option('--no-cache', 'build without the layer cache')
    .option('--skip-build', 'push and import an image that is already built locally')
    .option('--no-activate', 'import the version but leave the active pointer alone')
    .option('--timeout <seconds>', 'how long to wait for the import', (v) => parseInt(v, 10), 600)
    .action(
      async (
        name: string,
        dirArg: string | undefined,
        opts: {
          image: string
          tag?: string
          platform: string
          file?: string
          cache: boolean
          skipBuild?: boolean
          activate: boolean
          timeout: number
        },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const json = outputMode(flags) === 'json'
        if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
          throw new CliError('--timeout must be a positive number of seconds', ExitCode.Usage)
        }

        const dir = path.resolve(dirArg ?? '.')
        const tag = `${opts.image}:${opts.tag ?? defaultTag()}`

        if (!opts.skipBuild) await ensureBuildContext(dir)
        await requireDocker()

        // Resolve the API context before the build: a missing key should fail
        // in a second, not after a five-minute image build.
        const api = await apiContext(cmd)

        let digestRef: string
        try {
          if (!opts.skipBuild) {
            step(json, `Building ${tag} for ${opts.platform}`)
            await dockerBuild({
              context: dir,
              tag,
              platform: opts.platform,
              file: opts.file,
              noCache: !opts.cache,
            })
          }

          step(json, `Pushing ${tag}`)
          await dockerPush(tag)

          step(json, 'Resolving the digest')
          digestRef = await resolveDigest(tag)
        } catch (err) {
          throw asCliError(err)
        }

        step(json, `Importing ${digestRef}`)
        await ensureTemplate(api, name)

        let version: TemplateVersion
        try {
          version = await api.client.importTemplateVersion(name, digestRef)
        } catch (err) {
          throw asCliError(err)
        }

        const final = await waitForVersion(api, name, version.version, opts.timeout * 1000)
        if (final.status === 'failed') {
          throw new CliError(
            final.failureReason ?? `import of v${final.version} failed`,
            ExitCode.Failure,
            [
              'If the reason is a 401 or a manifest error, check the image is',
              'pullable without credentials: the platform mirrors from your',
              'registry and cannot authenticate to a private one yet.',
            ],
          )
        }
        if (final.status !== 'ready') {
          throw new CliError(
            `timed out after ${opts.timeout}s with v${final.version} still ${final.status}`,
            ExitCode.Failure,
            [`It may still finish. Check with: orca templates versions ${name}`],
          )
        }

        let activated = false
        if (opts.activate) {
          step(json, `Activating v${final.version}`)
          try {
            await api.client.activateTemplateVersion(name, final.version)
            activated = true
          } catch (err) {
            throw asCliError(err)
          }
        }

        if (json) {
          printJson({ template: name, image: digestRef, version: final, activated })
          return
        }
        console.log(
          `${accentVerb('Deployed')} v${final.version} of "${name}" from ${digestRef}` +
            (activated ? ' and activated it.' : ' (not activated).'),
        )
        if (activated) {
          console.error(
            hintText(`  point an agent at it: runtime "custom", template "${name}"`),
          )
        } else {
          console.error(hintText(`  activate it: orca templates activate ${name} ${final.version}`))
        }
      },
    )
}

// step narrates the long chain on stderr so a deploy is not a silent wait.
// Suppressed under --json, where stdout is the only output and stderr noise
// would still confuse a log.
function step(json: boolean, message: string): void {
  if (!json) console.error(hintText(`${message}...`))
}

// ensureTemplate makes deploy idempotent on first use. The point of the
// command is one step; making the user run `templates create` first because
// of a 404 would defeat it. An existing template is left exactly as it is.
async function ensureTemplate(api: ApiContext, name: string): Promise<void> {
  try {
    await api.client.getTemplate(name)
    return
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw asCliError(err)
  }
  try {
    await withApi(api, (c) => c.createTemplate({ name }))
  } catch (err) {
    // A concurrent deploy of the same name is a race we can simply lose:
    // the template exists either way, which is all this needed.
    if (err instanceof ApiError && err.status === 409) return
    throw asCliError(err)
  }
}
