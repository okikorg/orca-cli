import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Points the CLI config layer at a throwaway directory via ORCA_CONFIG_DIR.
// Call cleanup() in afterEach.
export async function useTmpConfigDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orca-cli-test-'))
  const prev = process.env.ORCA_CONFIG_DIR
  process.env.ORCA_CONFIG_DIR = dir
  return {
    dir,
    cleanup: async () => {
      if (prev === undefined) delete process.env.ORCA_CONFIG_DIR
      else process.env.ORCA_CONFIG_DIR = prev
      await rm(dir, { recursive: true, force: true })
    },
  }
}
