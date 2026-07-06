// Interactive helpers shared by destructive and key-minting commands.

import { printJson, renderInk } from '../lib/output.js'

export async function confirm(question: string): Promise<boolean> {
  const { promptText } = await import('../ui/PromptInput.js')
  const answer = await promptText({ label: question, hint: '(y/N)' })
  return /^y(es)?$/i.test(answer.trim())
}

// Issued keys are shown once. In a pipe, stdout carries only the token so
// scripts can capture it; humans get the framed reveal.
export async function revealIssuedKey(
  issued: { token: string; id: string },
  label: string,
  json: boolean,
): Promise<void> {
  if (json) {
    printJson(issued)
    return
  }
  if (!process.stdout.isTTY) {
    process.stdout.write(issued.token + '\n')
    console.error(`${label} (id ${issued.id})`)
    return
  }
  const { KeyReveal } = await import('../ui/KeyReveal.js')
  await renderInk(<KeyReveal token={issued.token} label={`${label} (id ${issued.id})`} />)
}
