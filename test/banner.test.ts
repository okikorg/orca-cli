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
  it('includes the ASCII wordmark and version', () => {
    // Non-TTY in tests, so no ANSI: assert on the plain art + tagline.
    const s = bannerString()
    expect(s).toContain('\\___/') // the O glyph tail
    expect(s).toContain('|_) |') // the R glyph
    expect(s).toContain('Manage agents')
    expect(s).toContain(`v${VERSION}`)
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

  it('emits coral ANSI on a color TTY', () => {
    process.stdout.isTTY = true
    vi.stubEnv('NO_COLOR', '')
    expect(bannerString()).toContain('38;2;254;120;93')
  })
})
