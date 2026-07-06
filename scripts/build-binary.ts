// Compiles the Orca CLI into standalone, self-contained executables with Bun.
// Each binary embeds the Bun runtime, so end users need no Node install.
//
// Usage:
//   bun scripts/build-binary.ts                # build every target below
//   bun scripts/build-binary.ts bun-linux-x64  # build one target
//
// Output: dist-bin/orca-<os>-<arch>[.exe]
//
// Bun cross-compiles every target from any host, so CI needs a single job.

import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string
}

// Bun compile target -> the `orca-<os>-<arch>` name install.sh looks for.
// Keep these asset names in sync with install.sh's `asset` mapping.
const TARGETS: Record<string, string> = {
  'bun-darwin-arm64': 'orca-darwin-arm64',
  'bun-darwin-x64': 'orca-darwin-x64',
  'bun-linux-x64': 'orca-linux-x64',
  'bun-linux-arm64': 'orca-linux-arm64',
  'bun-windows-x64': 'orca-windows-x64.exe',
}

// `ink` statically imports `react-devtools-core` (an optional dev-only dep) from
// a module it dynamically loads. Bun's bundler pulls that graph in and fails to
// resolve it. It only ever runs when a devtools websocket is reachable, so we
// stub it to an empty module: bundles clean, no-ops in production.
const stubReactDevtools = {
  name: 'stub-react-devtools',
  setup(build: import('bun').PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub-react-devtools',
    }))
    build.onLoad(
      { filter: /.*/, namespace: 'stub-react-devtools' },
      () => ({ contents: 'export default {}', loader: 'js' }),
    )
  },
}

async function buildTarget(target: string, assetName: string): Promise<void> {
  const outfile = `dist-bin/${assetName}`
  const result = await Bun.build({
    entrypoints: ['src/cli.ts'],
    target: 'bun',
    plugins: [stubReactDevtools],
    // Inline the version so the binary never reaches for package.json on disk.
    define: { __ORCA_VERSION__: JSON.stringify(pkg.version) },
    compile: { target, outfile },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`build failed for ${target}`)
  }
  console.log(`  built ${outfile}`)
}

async function main(): Promise<void> {
  const requested = process.argv[2]
  if (requested && !TARGETS[requested]) {
    console.error(`unknown target: ${requested}`)
    console.error(`known targets: ${Object.keys(TARGETS).join(', ')}`)
    process.exit(1)
  }

  await rm('dist-bin', { recursive: true, force: true })
  await mkdir('dist-bin', { recursive: true })

  const targets = requested ? [requested] : Object.keys(TARGETS)
  console.log(`building orca v${pkg.version} for ${targets.length} target(s):`)
  for (const target of targets) {
    await buildTarget(target, TARGETS[target])
  }
  console.log('done.')
}

await main()
