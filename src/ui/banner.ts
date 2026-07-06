import { VERSION } from '../version.js'
import { ansi, colorEnabled } from './theme.js'

// ASCII wordmark shown on the welcome/help screen. Slant figlet font, kept
// ASCII-only so it renders in any terminal. Coral, matching the brand.
const ART = [
  '   ____  ____  _________',
  '  / __ \\/ __ \\/ ____/   |',
  ' / / / / /_/ / /   / /| |',
  '/ /_/ / _, _/ /___/ ___ |',
  '\\____/_/ |_|\\____/_/  |_|',
]

const TAGLINE = 'Manage agents, runs, and publishing on the Orca platform'

export function bannerString(): string {
  const color = colorEnabled()
  const lines = ART.map((l) => (color ? `${ansi.accent}${l}${ansi.reset}` : l))
  const sub = color
    ? `${ansi.subtle}${TAGLINE}${ansi.reset}   ${ansi.muted}v${VERSION}${ansi.reset}`
    : `${TAGLINE}   v${VERSION}`
  return ['', ...lines, '', ` ${sub}`, ''].join('\n')
}

export function printBanner(): void {
  process.stdout.write(bannerString() + '\n')
}
