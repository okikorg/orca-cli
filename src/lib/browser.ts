// Opening a URL in the user's browser, for device login's verification page
// and the billing checkout and portal.

import { spawn } from 'node:child_process'

export type BrowserOpener = (url: string) => void

function defaultOpener(url: string): void {
  try {
    let cmd: string
    let args: string[]
    if (process.platform === 'darwin') {
      cmd = 'open'
      args = [url]
    } else if (process.platform === 'win32') {
      cmd = 'cmd'
      args = ['/c', 'start', '', url]
    } else {
      cmd = 'xdg-open'
      args = [url]
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      // No opener on this machine; the caller always prints the URL.
    })
    child.unref()
  } catch {
    // Launch is best-effort; the caller always prints the URL as a fallback.
  }
}

let opener: BrowserOpener = defaultOpener

// setBrowserOpener swaps the launcher. Exposed only so unit tests can drive
// the commands without spawning a browser; production code never calls this.
// Passing null restores the platform default.
export function setBrowserOpener(next: BrowserOpener | null): void {
  opener = next ?? defaultOpener
}

// openBrowser launches the user's default browser at the given URL, detached
// so the CLI keeps running. Failures are swallowed: the caller prints the URL.
export function openBrowser(url: string): void {
  opener(url)
}
