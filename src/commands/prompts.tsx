// Interactive helpers shared by destructive and key-minting commands.

import { printJson, renderStatic } from '../lib/output.js'

export async function confirm(question: string): Promise<boolean> {
  const { promptText } = await import('../ui/PromptInput.js')
  const answer = await promptText({ label: question, hint: '(y/N)' })
  return /^y(es)?$/i.test(answer.trim())
}

// confirmDestructive mounts the shared Confirm component for a y/N gate in
// interactive TTY mode (single keypress; Enter declines, so the safe answer is
// the default). Ctrl-C unmounts without a decision and is treated as a
// decline. Callers gate this on interactive(), so non-TTY runs never prompt.
export async function confirmDestructive(message: string): Promise<boolean> {
  const { render } = await import('ink')
  const { Confirm } = await import('../ui/Confirm.js')
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      instance.unmount()
      resolve(v)
    }
    const instance = render(<Confirm message={message} onDecision={finish} />, { exitOnCtrlC: true })
    void instance.waitUntilExit().then(() => finish(false))
  })
}

// Issued keys are shown once. In a pipe, stdout carries only the secret so
// scripts can capture it; humans get the framed reveal.
export async function revealIssuedKey(
  issued: { secret: string; id: string },
  label: string,
  json: boolean,
): Promise<void> {
  if (json) {
    printJson(issued)
    return
  }
  if (!process.stdout.isTTY) {
    process.stdout.write(issued.secret + '\n')
    console.error(`${label} (id ${issued.id})`)
    return
  }
  const { KeyReveal } = await import('../ui/KeyReveal.js')
  await renderStatic(<KeyReveal token={issued.secret} label={`${label} (id ${issued.id})`} />)
}
