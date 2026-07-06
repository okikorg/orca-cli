import { readFile } from 'node:fs/promises'

import { load as parseYaml, YAMLException } from 'js-yaml'

import { CliError, ExitCode } from './errors.js'
import { validateProfile } from './profile-schema.js'
import type { AgentProfile } from './types.js'

export type LoadedProfile = {
  profile: AgentProfile
  warnings: string[]
}

async function readSource(file: string): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`file not found: ${file}`, ExitCode.Usage)
    }
    throw err
  }
}

// loadProfileFile reads a YAML or JSON agent document (or stdin via "-"),
// validates its shape, and returns the normalised profile. YAML is a
// superset of JSON, so one parser covers both extensions.
export async function loadProfileFile(file: string, opts?: { strict?: boolean }): Promise<LoadedProfile> {
  const source = await readSource(file)
  if (!source.trim()) {
    throw new CliError(`${file === '-' ? 'stdin' : file} is empty`, ExitCode.Usage)
  }

  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    const reason = err instanceof YAMLException ? err.message.split('\n')[0] : String(err)
    throw new CliError(`could not parse ${file === '-' ? 'stdin' : file}: ${reason}`, ExitCode.Usage)
  }

  const result = validateProfile(raw)
  if (!result.ok || !result.profile) {
    throw new CliError('invalid agent document', ExitCode.Usage, result.errors)
  }
  if (opts?.strict && result.warnings.length > 0) {
    throw new CliError('invalid agent document (--strict)', ExitCode.Usage, result.warnings)
  }
  return { profile: result.profile, warnings: result.warnings }
}
