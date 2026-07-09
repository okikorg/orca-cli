import { afterEach, describe, expect, it, vi } from 'vitest'

import { bannerString } from '../src/ui/banner.js'
import { VERSION } from '../src/version.js'

const realIsTTY = process.stdout.isTTY

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.stdout.isTTY = realIsTTY
})

describe('bannerString', () => {
  it('is the one-line brand header with wordmark, tagline, and version', () => {
    // Non-TTY in tests, so no ANSI: assert on the plain text.
    const s = bannerString()
    expect(s).toContain('ORCA')
    expect(s).toContain('agent platform CLI')
    expect(s).toContain(`v${VERSION}`)
    // Figlet art is retired: no backslash-and-underscore ASCII glyphs remain.
    expect(s).not.toContain('\\____/')
  })

  it('renders on a single content line', () => {
    // Leading/trailing blank lines frame one content line.
    const content = bannerString().split('\n').filter(Boolean)
    expect(content).toHaveLength(1)
  })

  it('emits no ANSI escapes when stdout is not a TTY', () => {
    // process.stdout.isTTY is undefined under vitest.
    // eslint-disable-next-line no-control-regex
    expect(bannerString()).not.toMatch(/\x1b\[/)
  })

  it('emits no ANSI escapes when NO_COLOR is set even on a TTY', () => {
    process.stdout.isTTY = true
    vi.stubEnv('NO_COLOR', '1')
    // eslint-disable-next-line no-control-regex
    expect(bannerString()).not.toMatch(/\x1b\[/)
  })

  it('emits bold coral ANSI on a color TTY', () => {
    process.stdout.isTTY = true
    vi.stubEnv('NO_COLOR', '')
    const s = bannerString()
    expect(s).toContain('38;2;254;120;93') // coral
    expect(s).toContain('\x1b[1m') // bold ORCA
  })
})
