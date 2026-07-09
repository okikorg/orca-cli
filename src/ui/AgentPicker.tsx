import { render } from 'ink'

import { CliError, ExitCode } from '../lib/errors.js'
import { Picker } from './Picker.js'

// pickOne mounts the generic filterable Picker and resolves with the chosen
// value. Esc (onCancel) and Ctrl-C both reject with an interrupt (see
// promptText for the same pattern); the missing-arg error path in callers maps
// that to exit 2 / 130 as before. The former SelectInput-based picker lived
// here; it is now a thin wrapper so every call site inherits type-to-filter,
// the coral pointer, and a match count. `title` becomes the filter placeholder
// since the Picker draws no separate title line. Callers must check
// interactive() first.
export async function pickOne(title: string, values: string[]): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`cannot prompt for "${title}" without a terminal`)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cancel = () => {
      if (settled) return
      settled = true
      instance.unmount()
      reject(new CliError('cancelled', ExitCode.Interrupt))
    }
    const instance = render(
      <Picker
        items={values.map((v) => ({ label: v, value: v }))}
        placeholder={title}
        onSubmit={(value) => {
          if (settled) return
          settled = true
          instance.unmount()
          resolve(value)
        }}
        onCancel={cancel}
      />,
      { exitOnCtrlC: true },
    )
    // Ctrl-C unmounts Ink without calling onSubmit/onCancel; detect that via
    // waitUntilExit and reject with the same interrupt as an explicit esc.
    void instance.waitUntilExit().then(cancel)
  })
}
