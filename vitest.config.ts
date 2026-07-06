import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // Ink's first yoga-wasm layout blocks ~300ms and the full suite runs many
    // files in parallel; the 5s default flakes Ink-mounting tests under load.
    testTimeout: 20000,
  },
})
