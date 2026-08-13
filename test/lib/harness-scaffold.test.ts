import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import {
  HARNESS_SDKS,
  scaffoldFiles,
  SCAFFOLD_FILES,
} from '../../src/lib/harness-scaffold.js'

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

  // The whole design rests on this: only agent.ts knows which SDK you chose.
  // If a template quietly forks the protocol server, a fix applied once stops
  // reaching every harness, which is the thing the split exists to prevent.
  it('keeps the protocol byte-identical across every SDK', () => {
    const shared = ['protocol.ts', 'server.ts', 'tsconfig.json', '.dockerignore']
    const baseline = scaffoldFiles('none')
    for (const sdk of HARNESS_SDKS) {
      const files = scaffoldFiles(sdk)
      for (const name of shared) {
        expect(files.find((f) => f.path === name)?.content, `${name} differs for ${sdk}`).toBe(
          baseline.find((f) => f.path === name)?.content,
        )
      }
      // ...and agent.ts must actually differ, or the SDK choice did nothing.
      if (sdk !== 'none') {
        expect(files.find((f) => f.path === 'agent.ts')?.content).not.toBe(
          baseline.find((f) => f.path === 'agent.ts')?.content,
        )
      }
    }
  })

  it('copies every source file into the image', () => {
    // Missing a COPY is invisible until the container starts and dies on an
    // unresolved import, which is the worst place to find out. The scaffold
    // writes three .ts files and the Dockerfile has to carry all of them.
    for (const sdk of HARNESS_SDKS) {
      const files = scaffoldFiles(sdk)
      const dockerfile = files.find((f) => f.path === 'Dockerfile')?.content ?? ''
      for (const f of files.filter((f) => f.path.endsWith('.ts') && f.path !== 'tsconfig.json')) {
        expect(dockerfile, `${sdk} Dockerfile is missing ${f.path}`).toContain(f.path)
      }
    }
  })

  it('declares a runtime dependency for every SDK, and none for the stub', () => {
    for (const sdk of HARNESS_SDKS) {
      const pkg = JSON.parse(
        scaffoldFiles(sdk).find((f) => f.path === 'package.json')?.content ?? '{}',
      )
      const dockerfile = scaffoldFiles(sdk).find((f) => f.path === 'Dockerfile')?.content ?? ''
      if (sdk === 'none') {
        expect(pkg.dependencies).toBeUndefined()
        // Nothing to install means no install stage at all.
        expect(dockerfile).not.toContain('npm ci')
      } else {
        expect(Object.keys(pkg.dependencies ?? {}).length).toBeGreaterThan(0)
        expect(dockerfile).toContain('npm ci')
      }
      // The compiler is always a dev tool, never shipped.
      expect(pkg.devDependencies).toHaveProperty('typescript')
      expect(pkg.dependencies ?? {}).not.toHaveProperty('typescript')
    }
  })

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
