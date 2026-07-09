import { VERSION } from '../version.js'
import { ansi, colorEnabled, glyphs } from './theme.js'

// One-line brand banner shown for bare `orca` and top-level `--help`. Replaces
// the retired figlet art. Layout (double-space separators, no borders):
//   <mark> ORCA  agent platform CLI  vX.Y.Z
// rendered as coral mark, bold coral ORCA, subtle tagline, muted version. The
// mark is the landing favicon diagonal (`▀▄`) and is dropped in the ASCII glyph
// tier, so the line degrades to `ORCA  agent platform CLI  vX.Y.Z`.
const WORDMARK = 'ORCA'
const TAGLINE = 'agent platform CLI'

export function bannerString(): string {
  const color = colorEnabled()
  const mark = glyphs.brandMark
  const version = `v${VERSION}`

  if (!color) {
    const parts = [mark, WORDMARK, TAGLINE, version].filter(Boolean)
    return `\n${parts.join('  ')}\n`
  }

  const coloredMark = mark ? `${ansi.accent}${mark}${ansi.reset} ` : ''
  const coloredWord = `${ansi.bold}${ansi.accent}${WORDMARK}${ansi.reset}`
  const coloredTagline = `${ansi.subtle}${TAGLINE}${ansi.reset}`
  const coloredVersion = `${ansi.muted}${version}${ansi.reset}`
  return `\n${coloredMark}${coloredWord}  ${coloredTagline}  ${coloredVersion}\n`
}

export function printBanner(): void {
  process.stdout.write(bannerString() + '\n')
}
