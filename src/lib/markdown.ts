// Markdown-lite: a pure string->string renderer for the small subset of
// markdown that assistant replies actually use. No Ink imports and no color
// tokens from the theme module (theme.ts imports Ink-adjacent code); the ANSI
// codes are inlined here so this stays a leaf lib usable from any sink.
//
// Supported: ATX headings (bold), **bold**, *italic* (rendered bold - many
// terminals lack italics), `inline code` (accentStrong), fenced ``` blocks
// (two-space indent, muted, contents left verbatim), `- ` bullet lists (glyph
// bullet), and [text](url) links (-> `text (url)` with a subtle url).
// Everything else passes through unchanged.
//
// opts.color=false yields plain text: markers are still stripped/normalized so
// the output reads cleanly, but no ANSI escapes are emitted. Callers that must
// keep a machine contract (piped / --json) pass color:false.

// Inlined ANSI, mirroring src/ui/theme.ts tokens. Kept in sync by hand; this
// module deliberately does not import theme to stay a leaf.
const ANSI = {
  accentStrong: '\x1b[38;2;240;84;60m',
  subtle: '\x1b[38;2;117;117;117m',
  muted: '\x1b[38;2;168;168;168m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const

// Bullet glyph: chosen once. A leaf lib cannot import the Ink theme's glyph
// selection without pulling Ink in, so it mirrors the same tier decision
// (ORCA_ASCII / UTF-8 locale) locally.
function bulletGlyph(): string {
  const env = process.env
  if (env.ORCA_ASCII === '1') return '-'
  if (process.platform === 'win32') {
    return env.WT_SESSION || env.TERM_PROGRAM === 'vscode' ? '·' : '-'
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  return /UTF-?8$/i.test(locale) ? '·' : '-'
}

type Opts = { color: boolean }

function wrap(text: string, code: string, color: boolean): string {
  if (!color) return text
  return `${code}${text}${ANSI.reset}`
}

// Inline spans, applied left-to-right on a single line. Order matters: code
// spans are extracted first so their contents are not re-scanned for bold or
// link syntax.
function renderInline(line: string, opts: Opts): string {
  const { color } = opts

  // `inline code` -> accentStrong. Non-greedy, no nesting.
  let out = line.replace(/`([^`]+)`/g, (_m, code: string) =>
    wrap(code, ANSI.accentStrong, color),
  )

  // [text](url) -> text (url), url subtle.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text: string, url: string) =>
      `${text} (${wrap(url, ANSI.subtle, color)})`,
  )

  // **bold** and __bold__ -> bold.
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) =>
    wrap(t, ANSI.bold, color),
  )
  out = out.replace(/__([^_]+)__/g, (_m, t: string) => wrap(t, ANSI.bold, color))

  // *italic* / _italic_ -> bold (terminals lack reliable italics). Run after
  // the bold pass so leftover single markers only match true single-emphasis.
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, (_m, pre: string, t: string) =>
    `${pre}${wrap(t, ANSI.bold, color)}`,
  )
  out = out.replace(/(^|[^_])_([^_]+)_/g, (_m, pre: string, t: string) =>
    `${pre}${wrap(t, ANSI.bold, color)}`,
  )

  return out
}

export function renderMarkdown(md: string, opts: Opts): string {
  const { color } = opts
  const bullet = bulletGlyph()
  const lines = md.split('\n')
  const out: string[] = []
  let inFence = false

  for (const line of lines) {
    const fenceMatch = /^\s*```/.test(line)
    if (fenceMatch) {
      // Toggle fenced-code mode; drop the ``` fence line itself.
      inFence = !inFence
      continue
    }

    if (inFence) {
      // Code block body: two-space indent, muted, contents verbatim (no inline
      // markdown parsing inside code).
      out.push(`  ${wrap(line, ANSI.muted, color)}`)
      continue
    }

    // ATX heading: strip leading #'s, render the text bold.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(wrap(renderInline(heading[2], opts), ANSI.bold, color))
      continue
    }

    // Unordered list item: `- `, `* `, or `+ ` -> glyph bullet, preserving
    // the original indentation.
    const bulletItem = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bulletItem) {
      out.push(`${bulletItem[1]}${bullet} ${renderInline(bulletItem[2], opts)}`)
      continue
    }

    out.push(renderInline(line, opts))
  }

  return out.join('\n')
}
