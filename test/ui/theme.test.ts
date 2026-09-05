import { afterEach, describe, expect, it, vi } from 'vitest'

import { ansi, glyphs, POINTER, productTheme, theme, unicodeEnabled } from '../../src/ui/theme.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

// unicodeEnabled reads env live, so we exercise the tier selection through it.
// glyphs/POINTER are resolved once at module load and are asserted for shape.
describe('unicodeEnabled', () => {
  it('forces the ASCII tier when ORCA_ASCII=1, even on a UTF-8 locale', () => {
    vi.stubEnv('ORCA_ASCII', '1')
    vi.stubEnv('LC_ALL', 'en_US.UTF-8')
    expect(unicodeEnabled()).toBe(false)
  })

  it('picks the Unicode tier on a UTF-8 locale (non-Windows)', () => {
    if (process.platform === 'win32') return
    vi.stubEnv('ORCA_ASCII', '')
    vi.stubEnv('LC_ALL', '')
    vi.stubEnv('LC_CTYPE', '')
    vi.stubEnv('LANG', 'en_US.UTF-8')
    expect(unicodeEnabled()).toBe(true)
  })

  it('picks the ASCII tier on a non-UTF-8 locale (non-Windows)', () => {
    if (process.platform === 'win32') return
    vi.stubEnv('ORCA_ASCII', '')
    vi.stubEnv('LC_ALL', '')
    vi.stubEnv('LC_CTYPE', '')
    vi.stubEnv('LANG', 'C')
    expect(unicodeEnabled()).toBe(false)
  })

  it('accepts the utf8 spelling without a hyphen', () => {
    if (process.platform === 'win32') return
    vi.stubEnv('ORCA_ASCII', '')
    vi.stubEnv('LC_ALL', 'en_US.utf8')
    expect(unicodeEnabled()).toBe(true)
  })

  it('prefers LC_ALL over LANG', () => {
    if (process.platform === 'win32') return
    vi.stubEnv('ORCA_ASCII', '')
    vi.stubEnv('LC_ALL', 'C')
    vi.stubEnv('LC_CTYPE', '')
    vi.stubEnv('LANG', 'en_US.UTF-8')
    expect(unicodeEnabled()).toBe(false)
  })
})

describe('glyphs', () => {
  it('exposes a stable role shape for every tier', () => {
    for (const role of [
      'pointer',
      'statusFilled',
      'statusOpen',
      'treeBranch',
      'treeLast',
      'treeVertical',
      'separator',
      'brandMark',
      'rule',
    ] as const) {
      expect(typeof glyphs[role]).toBe('string')
    }
    expect(Array.isArray(glyphs.spinner)).toBe(true)
    expect(glyphs.spinner.length).toBeGreaterThan(0)
  })

  it('keeps POINTER as an alias of glyphs.pointer', () => {
    expect(POINTER).toBe(glyphs.pointer)
  })

  it('resolved to the tier matching the current environment', () => {
    // The module was loaded under the test env; assert the two agree so the
    // once-at-startup selection is not silently wrong.
    if (unicodeEnabled()) {
      expect(glyphs.pointer).toBe('»')
      expect(glyphs.brandMark).toBe('▀▄')
    } else {
      expect(glyphs.pointer).toBe('>')
      expect(glyphs.brandMark).toBe('')
    }
  })
})

describe('color roles', () => {
  it('keeps primary actions inverse and the brand accent mint in both modes', () => {
    expect(productTheme.light).toMatchObject({
      primary: '#000000',
      accent: '#12A566',
    })
    expect(productTheme.dark).toMatchObject({
      primary: '#FDFDFD',
      accent: '#5BE49B',
    })
  })

  it('keeps the dark-first Ink and ANSI accents aligned', () => {
    expect(theme.accent).toBe('#5BE49B')
    expect(theme.accentStrong).toBe('#7DEDB2')
    expect(ansi.accent).toBe('\x1b[38;2;91;228;155m')
    expect(ansi.accentStrong).toBe('\x1b[38;2;125;237;178m')
  })
})
