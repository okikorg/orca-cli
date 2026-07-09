// Orca design language, translated to the terminal. Source tokens:
// dashboard/src/index.css and landing/src/index.css. Components import from
// here and never hardcode a color or a glyph.
//
// Grammar (see docs/superpowers/specs/2026-07-09-cli-ui-modernization-design.md):
// - Hierarchy comes from whitespace and weight, not boxes. No panel borders.
//   The border token survives only for tree edges (topology, workflow DAG) and
//   chart axes.
// - A view starts with a header line: bold coral title, then ` · `-separated
//   metadata in subtle gray. Content rows indent two spaces; blank lines
//   separate groups.
// - Coral is the ONLY accent: headers, prompt marker, running/active state,
//   primary emphasis. Status palette: running=accent, error=destructive,
//   cancelled/interrupted=subtle, ok=default foreground.
// - Default foreground is left to the user's terminal; we only color emphasis,
//   secondary text, tree/axis edges, and errors.
// - No emoji, ever. No rounded/double borders. No background colors.
// - Glyphs route through `glyphs` (below): a safe CP437/Latin-1 tier by
//   default, an ASCII tier when the locale is not UTF-8 or ORCA_ASCII is set.

import type { RunStatus } from '../lib/types.js'

export const theme = {
  // Brand coral, --accent hsl(10 100% 68%) = #FE785D.
  accent: '#FE785D',
  // --accent-strong hsl(10 90% 58%).
  accentStrong: '#F0543C',
  // --text-muted (66%): secondary text, table body.
  muted: '#A8A8A8',
  // --text-subtle (46%): hints, timestamps, dividers.
  subtle: '#757575',
  // --destructive hsl(0 70% 55%).
  destructive: '#DC3C3C',
  // --border-strong on dark (~24%): panel frames, rules.
  border: '#3D3D3D',
} as const

// The coral wordmark and subtle grays as raw 24-bit ANSI, for the banner and
// any output that renders outside Ink. Mirrors the hex tokens above.
export const ansi = {
  accent: '\x1b[38;2;254;120;93m',
  accentStrong: '\x1b[38;2;240;84;60m',
  muted: '\x1b[38;2;168;168;168m',
  subtle: '\x1b[38;2;117;117;117m',
  destructive: '\x1b[38;2;220;60;60m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const

// unicodeEnabled decides the glyph tier, once, at startup. ORCA_ASCII=1 forces
// the ASCII tier. Otherwise: on non-Windows we accept the Unicode tier only
// when the locale env (LC_ALL / LC_CTYPE / LANG) advertises UTF-8, since the
// user's terminal font renders tofu for anything outside the CP437/Latin-1
// safe set on a non-UTF-8 locale; on Windows we use the same terminal
// heuristics is-unicode-supported uses (Windows Terminal, VS Code, ConEmu,
// mintty), hand-rolled to avoid a dependency. This is orthogonal to color:
// NO_COLOR and non-TTY suppress color, not glyphs.
export function unicodeEnabled(): boolean {
  const env = process.env
  if (env.ORCA_ASCII === '1') return false

  if (process.platform !== 'win32') {
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
    return /UTF-?8$/i.test(locale)
  }

  // Windows: no reliable locale signal, so gate on the terminal instead.
  return Boolean(
    env.WT_SESSION || // Windows Terminal
      env.TERMINUS_SUBLIME || // Terminus
      env.ConEmuTask === '{cmd::Cmder}' || // ConEmu / cmder
      env.TERM_PROGRAM === 'Terminus-Sublime' ||
      env.TERM_PROGRAM === 'vscode' ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'alacritty' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm',
  )
}

// Glyph tiers. Every glyph the UI draws comes from here, chosen once via
// unicodeEnabled(). The Unicode tier is restricted to the CP437/Latin-1 legacy
// set (universal font coverage); never add a glyph outside that tier. Do NOT
// use the tofu offenders `▚ ❯ ✖ ✔ ✓ ▲ ◐` or braille.
const UNICODE_GLYPHS = {
  pointer: '»',
  statusFilled: '●',
  statusOpen: '○',
  treeBranch: '├',
  treeLast: '└',
  treeVertical: '│',
  separator: '·',
  brandMark: '▀▄',
  rule: '─',
  spinner: ['░', '▒', '▓', '█', '▓', '▒'],
} as const

const ASCII_GLYPHS = {
  pointer: '>',
  statusFilled: '*',
  statusOpen: 'o',
  treeBranch: '|-',
  treeLast: '`-',
  treeVertical: '|',
  separator: '-',
  brandMark: '', // no mark in the ASCII tier
  rule: '-',
  spinner: ['-', '\\', '|', '/'],
} as const

// The active glyph set, resolved once at module load. Shape is stable across
// tiers so call sites read `glyphs.pointer` etc. without a branch.
export const glyphs: {
  pointer: string
  statusFilled: string
  statusOpen: string
  treeBranch: string
  treeLast: string
  treeVertical: string
  separator: string
  brandMark: string
  rule: string
  spinner: readonly string[]
} = unicodeEnabled() ? UNICODE_GLYPHS : ASCII_GLYPHS

// Pointer glyph for pickers, kept as an alias so existing call sites compile.
// Selection state per the design language: coral pointer plus coral text.
export const POINTER = glyphs.pointer

export function statusColor(status: RunStatus): string | undefined {
  switch (status) {
    case 'running':
      return theme.accent
    case 'error':
      return theme.destructive
    case 'cancelled':
    case 'interrupted':
      return theme.subtle
    case 'ok':
      return undefined
  }
}

// Same mapping as statusColor, as a raw ANSI code for the plain-text sinks
// (outside Ink) that print a run's terminal status, e.g. `orca run` on exit.
export function statusAnsiCode(status: RunStatus): string {
  switch (status) {
    case 'running':
      return ansi.accent
    case 'error':
      return ansi.destructive
    case 'cancelled':
    case 'interrupted':
      return ansi.subtle
    case 'ok':
      return ''
  }
}

// colorEnabled gates ANSI escapes: honor NO_COLOR and skip color when stdout
// is not a terminal (piped/redirected output stays clean).
export function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}

// paint wraps `text` in a raw ANSI code when colors are enabled, otherwise
// returns it unmodified. For single-line decoration that renders outside
// Ink (mutation confirmations, hints, errors) where mounting a component
// would be overkill; every command's plain/piped path stays untouched
// because colorEnabled() is false there.
export function paint(text: string, code: string): string {
  if (!code || !colorEnabled()) return text
  return `${code}${text}${ansi.reset}`
}

// Bold coral verb prefix for one-line mutation confirmations ("Created",
// "Deleted", "Published", ...): primary emphasis, the same role accent plays
// for panel titles and active state.
export function accentVerb(text: string): string {
  return paint(text, ansi.bold + ansi.accent)
}

// Subtle-colored hint/warning line: secondary, non-error informational text
// (empty-state hints, "Aborted.", "warning: ..."). Never destructive - that
// family is reserved for actual errors.
export function hintText(text: string): string {
  return paint(text, ansi.subtle)
}
