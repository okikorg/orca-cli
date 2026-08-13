import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import {
  HARNESS_SDKS,
  PROTOCOL_PACKAGE,
  scaffoldFiles,
  SCAFFOLD_FILES,
} from '../../src/lib/harness-scaffold.js'

const execFileP = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// The scaffold is written inside the repo rather than into os.tmpdir() so that
// tsc resolves @types/node by walking up to the repo's node_modules. A harness
// user gets those types from their own npm install; here we borrow ours.
const checkDir = path.join(repoRoot, 'node_modules', '.scaffold-typecheck')

// The protocol library lives in its own repository. Until it is on the
// registry there is nothing to install, so the compile test resolves it from a
// sibling checkout when one is present and says so loudly when it is not,
// rather than quietly passing while checking nothing.
const siblingProtocol = path.resolve(repoRoot, '..', 'harness-protocol')
const protocolTypes = path.join(siblingProtocol, 'dist', 'index.d.ts')
const haveProtocol = existsSync(protocolTypes)

afterAll(async () => {
  await rm(checkDir, { recursive: true, force: true })
})

describe('the scaffold compiles', () => {
  // The unit tests assert on the scaffold's text, which cannot tell whether
  // the TypeScript is valid. It once shipped with a noUncheckedIndexedAccess
  // error, so `npm run typecheck` failed on a freshly initialised project.
  // This runs the compiler the scaffold tells the user to run.
  it.skipIf(!haveProtocol)('passes tsc under its own tsconfig', async () => {
    await rm(checkDir, { recursive: true, force: true })
    await mkdir(checkDir, { recursive: true })
    for (const f of SCAFFOLD_FILES) {
      await writeFile(path.join(checkDir, f.path), f.content)
    }

    // Extends the scaffold's real tsconfig and adds only the resolution the
    // sibling checkout needs, so what is under test stays the shipped file.
    await writeFile(
      path.join(checkDir, 'tsconfig.check.json'),
      JSON.stringify({
        extends: './tsconfig.json',
        // No baseUrl: it is deprecated in TypeScript 6, and an absolute path
        // entry does not need one.
        compilerOptions: { paths: { [PROTOCOL_PACKAGE]: [protocolTypes] } },
      }),
    )

    const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc')
    const { stdout, stderr } = await execFileP(tsc, [
      '--noEmit',
      '--project',
      path.join(checkDir, 'tsconfig.check.json'),
    ]).catch((err: { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err),
    }))
    expect(`${stdout}${stderr}`.trim()).toBe('')
  }, 60_000)

  // The whole design rests on this: only index.ts knows which SDK you chose.
  // If a template quietly forks anything else, a fix applied once stops
  // reaching every harness, which is the thing the split exists to prevent.
  it('keeps everything but index.ts byte-identical across every SDK', () => {
    const shared = ['tsconfig.json', 'Dockerfile', '.dockerignore']
    const baseline = scaffoldFiles('none')
    for (const sdk of HARNESS_SDKS) {
      const files = scaffoldFiles(sdk)
      for (const name of shared) {
        expect(files.find((f) => f.path === name)?.content, `${name} differs for ${sdk}`).toBe(
          baseline.find((f) => f.path === name)?.content,
        )
      }
      // ...and index.ts must actually differ, or the SDK choice did nothing.
      if (sdk !== 'none') {
        expect(files.find((f) => f.path === 'index.ts')?.content).not.toBe(
          baseline.find((f) => f.path === 'index.ts')?.content,
        )
      }
    }
  })

  it('ships no protocol implementation for the author to maintain', () => {
    // The regression that would undo this change: putting the wire back into
    // the project, where it drifts from the library and stops getting fixes.
    for (const sdk of HARNESS_SDKS) {
      const files = scaffoldFiles(sdk)
      expect(files.map((f) => f.path).sort()).toEqual([
        '.dockerignore',
        'Dockerfile',
        'README.md',
        'index.ts',
        'package.json',
        'tsconfig.json',
      ])
      const index = files.find((f) => f.path === 'index.ts')?.content ?? ''
      expect(index, `${sdk} reimplements the server`).not.toMatch(/createServer|x-ndjson/)
      expect(index).toContain(PROTOCOL_PACKAGE)
    }
  })

  it('copies every source file into the image', () => {
    // Missing a COPY is invisible until the container starts and dies on an
    // unresolved import, which is the worst place to find out.
    for (const sdk of HARNESS_SDKS) {
      const files = scaffoldFiles(sdk)
      const dockerfile = files.find((f) => f.path === 'Dockerfile')?.content ?? ''
      for (const f of files.filter((f) => f.path.endsWith('.ts') && f.path !== 'tsconfig.json')) {
        expect(dockerfile, `${sdk} Dockerfile is missing ${f.path}`).toContain(f.path)
      }
      // Dependencies now always exist, so the install stage always has to run.
      expect(dockerfile).toContain('npm ci')
    }
  })

  it('declares the protocol library for every SDK, and the SDK alongside it', () => {
    for (const sdk of HARNESS_SDKS) {
      const pkg = JSON.parse(
        scaffoldFiles(sdk).find((f) => f.path === 'package.json')?.content ?? '{}',
      )
      expect(pkg.dependencies, `${sdk} must depend on the protocol library`).toHaveProperty(
        PROTOCOL_PACKAGE,
      )
      const extras = Object.keys(pkg.dependencies).filter((d) => d !== PROTOCOL_PACKAGE)
      if (sdk === 'none') {
        expect(extras, 'the stub needs nothing but the protocol').toEqual([])
      } else {
        expect(extras.length).toBeGreaterThan(0)
      }
      // The compiler is always a dev tool, never shipped.
      expect(pkg.devDependencies).toHaveProperty('typescript')
      expect(pkg.dependencies).not.toHaveProperty('typescript')
    }
  })

  it('lets the protocol dependency be pointed somewhere else', () => {
    const pkg = JSON.parse(
      scaffoldFiles('none', { protocol: 'file:../harness-protocol' }).find(
        (f) => f.path === 'package.json',
      )?.content ?? '{}',
    )
    expect(pkg.dependencies[PROTOCOL_PACKAGE]).toBe('file:../harness-protocol')
  })

  it('uses only syntax Node can erase, which erasableSyntaxOnly enforces', () => {
    // Enums, namespaces, and parameter properties type-check and then fail at
    // runtime under type stripping. The tsconfig flag is what catches them,
    // and the compile above is what proves the flag is satisfied.
    const tsconfig = SCAFFOLD_FILES.find((f) => f.path === 'tsconfig.json')?.content ?? ''
    expect(tsconfig).toContain('"erasableSyntaxOnly": true')

    for (const sdk of HARNESS_SDKS) {
      const index = scaffoldFiles(sdk).find((f) => f.path === 'index.ts')?.content ?? ''
      expect(index, sdk).not.toMatch(/\benum\b/)
      expect(index, sdk).not.toMatch(/\bnamespace\b/)
    }
  })
})
