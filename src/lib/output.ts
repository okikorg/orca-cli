// Output mode selection shared by every command:
//   --json          machine-readable JSON on stdout, Ink never mounts
//   stdout not TTY  plain tab-separated lines (grep/cut friendly), no color
//   TTY             Ink components
import type { ReactElement } from 'react'

export type OutputMode = 'json' | 'plain' | 'ink'

export function outputMode(flags: { json?: boolean }): OutputMode {
  if (flags.json) return 'json'
  if (!process.stdout.isTTY) return 'plain'
  return 'ink'
}

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

// Plain mode: tab-separated, no header row, mirroring gh's scripts output.
export function printPlainRows(rows: (string | number | null | undefined)[][]): void {
  for (const row of rows) {
    process.stdout.write(row.map((c) => (c == null ? '' : String(c))).join('\t') + '\n')
  }
}

// renderInk mounts a self-managed Ink view (one that calls exit() itself,
// e.g. the run tail) and resolves when it exits.
export async function renderInk(element: ReactElement): Promise<void> {
  const { render } = await import('ink')
  const instance = render(element, { exitOnCtrlC: true })
  await instance.waitUntilExit()
}

// renderStatic mounts a one-shot view (tables, detail panels, key reveal)
// that has no exit logic of its own: paint the first frame, then unmount so
// control returns to the shell. Without this, waitUntilExit() never resolves
// and the command hangs in a real terminal.
export async function renderStatic(element: ReactElement): Promise<void> {
  const { render } = await import('ink')
  const instance = render(element)
  // Let the initial frame commit before tearing down; unmount persists it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  instance.unmount()
  await instance.waitUntilExit()
}
