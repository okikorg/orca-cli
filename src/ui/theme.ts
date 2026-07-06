// Orca design language, translated to the terminal. Source tokens:
// dashboard/src/index.css and landing/src/index.css (dark-first, flat,
// border-delineated, instrument aesthetic). Components import from here and
// never hardcode colors.
//
// Rules carried over from the design language:
// - coral is the one accent: wordmark, panel titles, selection pointer,
//   active/primary emphasis
// - panels are delineated by single-line borders (the flat, 2px-radius look);
//   no rounded or double border styles
// - selection/active state is the coral pointer plus coral text, never an
//   accent bar or inverted block
// - default foreground is left to the user's terminal; we only color
//   emphasis, secondary text, borders, and errors

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

// Pointer glyph for pickers; matches the flat instrument look.
export const POINTER = '>'

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
