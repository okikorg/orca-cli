import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderMarkdown, stripControlSequences } from '../../src/lib/markdown.js'

const plain = { color: false }
const colored = { color: true }

afterEach(() => {
  vi.unstubAllEnvs()
})

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/

describe('renderMarkdown (color: false)', () => {
  it('never emits ANSI escapes', () => {
    const md = '# Heading\n\n**bold** and *italic* and `code`\n\n- one\n- two'
    expect(renderMarkdown(md, plain)).not.toMatch(ANSI_RE)
  })

  it('strips heading markers', () => {
    expect(renderMarkdown('## Title', plain)).toBe('Title')
  })

  it('strips bold/italic markers, keeping the text', () => {
    expect(renderMarkdown('a **b** c *d* e', plain)).toBe('a b c d e')
  })

  it('strips backticks from inline code', () => {
    expect(renderMarkdown('use `npm test` now', plain)).toBe('use npm test now')
  })

  it('rewrites links to text (url)', () => {
    expect(renderMarkdown('see [docs](https://x.io)', plain)).toBe(
      'see docs (https://x.io)',
    )
  })

  it('drops fence lines and indents code block bodies two spaces', () => {
    const md = '```\nline1\nline2\n```'
    expect(renderMarkdown(md, plain)).toBe('  line1\n  line2')
  })

  it('does not parse inline markdown inside a fenced block', () => {
    const md = '```\n**not bold** and `not code`\n```'
    expect(renderMarkdown(md, plain)).toBe('  **not bold** and `not code`')
  })

  it('renders a bullet glyph for list items', () => {
    // Under a non-UTF-8 locale the ASCII bullet is a hyphen.
    vi.stubEnv('ORCA_ASCII', '1')
    expect(renderMarkdown('- item', plain)).toBe('- item')
  })

  it('uses the unicode bullet on a UTF-8 locale', () => {
    if (process.platform === 'win32') return
    vi.stubEnv('ORCA_ASCII', '')
    vi.stubEnv('LC_ALL', 'en_US.UTF-8')
    expect(renderMarkdown('- item', plain)).toBe('· item')
  })

  it('passes plain paragraphs through unchanged', () => {
    expect(renderMarkdown('just a line', plain)).toBe('just a line')
  })
})

describe('renderMarkdown (color: true)', () => {
  it('wraps inline code in the accentStrong code', () => {
    const out = renderMarkdown('run `x`', colored)
    expect(out).toContain('\x1b[38;2;240;84;60m') // accentStrong
    expect(out).toContain('x')
  })

  it('wraps bold in the bold code', () => {
    const out = renderMarkdown('**hi**', colored)
    expect(out).toContain('\x1b[1m')
    expect(out).toContain('hi')
  })

  it('renders italic as bold too', () => {
    const out = renderMarkdown('*hi*', colored)
    expect(out).toContain('\x1b[1m')
  })

  it('renders a heading bold', () => {
    const out = renderMarkdown('# Title', colored)
    expect(out).toContain('\x1b[1m')
    expect(out).toContain('Title')
  })

  it('colors the link url subtle and leaves the text bare', () => {
    const out = renderMarkdown('[docs](https://x.io)', colored)
    expect(out).toContain('docs (')
    expect(out).toContain('\x1b[38;2;117;117;117m') // subtle url
  })

  it('mutes fenced code block bodies', () => {
    const out = renderMarkdown('```\ncode\n```', colored)
    expect(out).toContain('\x1b[38;2;168;168;168m') // muted
    expect(out).toContain('  ') // two-space indent
  })
})

// Remote replies are untrusted: raw escape/control bytes embedded in
// otherwise-plain text must be neutralized before they reach a terminal
// (OSC retitles windows / writes the clipboard, CSI moves and erases).
describe('control-sequence stripping', () => {
  it('strips OSC sequences (BEL- and ST-terminated, and unterminated)', () => {
    expect(stripControlSequences('a\x1b]0;evil\x07b')).toBe('ab')
    expect(stripControlSequences('a\x1b]52;c;payload\x1b\\b')).toBe('ab')
    expect(stripControlSequences('a\x1b]0;dangling')).toBe('a')
  })

  it('strips CSI sequences and C1 aliases', () => {
    expect(stripControlSequences('a\x1b[2Jb')).toBe('ab')
    expect(stripControlSequences('a\x1b[38;2;1;2;3mb')).toBe('ab')
    expect(stripControlSequences('a\u009b2Jb')).toBe('a2Jb') // C1 CSI byte dropped
  })

  it('strips DCS/APC strings and lone escapes', () => {
    expect(stripControlSequences('a\x1bPqpayload\x1b\\b')).toBe('ab')
    expect(stripControlSequences('a\x1b_hidden\x1b\\b')).toBe('ab')
    expect(stripControlSequences('a\x1bcb')).toBe('ab') // RIS
    expect(stripControlSequences('trailing\x1b')).toBe('trailing')
  })

  it('strips stray C0 controls but keeps newlines and tabs', () => {
    expect(stripControlSequences('a\x00\x08\x0b\x7fb')).toBe('ab')
    expect(stripControlSequences('line1\nline2\tend')).toBe('line1\nline2\tend')
    expect(stripControlSequences('cr\rout')).toBe('crout')
  })

  it('renderMarkdown neutralizes injected sequences in both color modes', () => {
    const md = 'safe \x1b]0;pwn\x07text **bold\x1b[2J** end'
    const plainOut = renderMarkdown(md, plain)
    expect(plainOut).toBe('safe text bold end')
    const coloredOut = renderMarkdown(md, colored)
    expect(coloredOut).not.toContain('\x1b]')
    expect(coloredOut).not.toContain('\x1b[2J')
  })
})
