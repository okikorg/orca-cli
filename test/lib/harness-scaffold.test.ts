import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import { SCAFFOLD_FILES } from '../../src/lib/harness-scaffold.js'

const execFileP = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// The scaffold is written inside the repo rather than into os.tmpdir() so that
// tsc resolves @types/node by walking up to the repo's node_modules. A harness
// user gets those types from their own npm install; here we borrow ours.
const checkDir = path.join(repoRoot, 'node_modules', '.scaffold-typecheck')

afterAll(async () => {
  await rm(checkDir, { recursive: true, force: true })
})

describe('the scaffold compiles', () => {
  // The unit tests assert on the scaffold's text, which cannot tell whether
  // the TypeScript is valid. It once shipped with a noUncheckedIndexedAccess
  // error, so `npm run typecheck` failed on a freshly initialised project.
  // This runs the compiler the scaffold tells the user to run.
  it('passes tsc under its own tsconfig', async () => {
    await rm(checkDir, { recursive: true, force: true })
    await mkdir(checkDir, { recursive: true })
    for (const f of SCAFFOLD_FILES) {
      await writeFile(path.join(checkDir, f.path), f.content)
    }

    const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc')
    const { stdout, stderr } = await execFileP(tsc, ['--noEmit', '--project', checkDir]).catch(
      (err: { stdout?: string; stderr?: string }) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? String(err),
      }),
    )
    expect(`${stdout}${stderr}`.trim()).toBe('')
  }, 60_000)

  it('uses only syntax Node can erase, which erasableSyntaxOnly enforces', () => {
    // Enums, namespaces, and parameter properties type-check and then fail at
    // runtime under type stripping. The tsconfig flag is what catches them,
    // and the compile above is what proves the flag is satisfied.
    const tsconfig = SCAFFOLD_FILES.find((f) => f.path === 'tsconfig.json')?.content ?? ''
    expect(tsconfig).toContain('"erasableSyntaxOnly": true')

    const server = SCAFFOLD_FILES.find((f) => f.path === 'server.ts')?.content ?? ''
    expect(server).not.toMatch(/\benum\b/)
    expect(server).not.toMatch(/\bnamespace\b/)
  })
})
