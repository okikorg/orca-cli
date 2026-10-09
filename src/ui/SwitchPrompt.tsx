import { Box, Text } from 'ink'
import { useState } from 'react'

import { SWITCH_WARNING } from '../lib/models.js'
import { Picker, type PickerItem } from './Picker.js'
import { theme } from './theme.js'

// What the other side of who pays offers a session: its models, the one to
// preselect (the same OpenRouter model, if listed), and the provider whose
// account ran out, for the wording.
export type SwitchOffer = { items: PickerItem[]; initial?: string; provider: string | null }

// How the prompt ended: a model to switch to, a top-up instead, or no model
// on the other side to switch to.
export type SwitchChoice = { kind: 'switch'; model: string } | { kind: 'top-up' } | { kind: 'no-models' }

type SwitchPromptProps = {
  out: 'orca_credit' | 'provider_quota'
  offer: SwitchOffer
  onDone: (choice: SwitchChoice) => void
}

// The switch of who pays after a credit ran out (orca-design model-billing
// D3.13): the design's warning, then "top up, or switch this session?", then
// the other side's models. One component for both steps, so the REPL and a
// single turn at a terminal ask the same way in one Ink tree.
export function SwitchPrompt({ out, offer, onDone }: SwitchPromptProps) {
  const [step, setStep] = useState<'ask' | 'model'>('ask')
  if (step === 'model') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Select a model</Text>
        <Picker
          items={offer.items}
          initial={offer.initial}
          placeholder="type to filter"
          onSubmit={(model) => onDone({ kind: 'switch', model })}
          onCancel={() => onDone({ kind: 'top-up' })}
        />
      </Box>
    )
  }
  const topUp = out === 'orca_credit' ? 'Top up first (orca billing wallet)' : `Top up at ${offer.provider ?? 'your provider'} first`
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>{SWITCH_WARNING}</Text>
      <Text bold>Top up, or switch this session?</Text>
      <Picker
        items={[
          { label: out === 'orca_credit' ? 'Switch this session to your own key' : 'Switch this session to Orca credit', value: 'switch' },
          { label: topUp, value: 'top-up' },
        ]}
        placeholder="choose"
        onSubmit={(choice) => {
          if (choice !== 'switch') onDone({ kind: 'top-up' })
          else if (offer.items.length === 0) onDone({ kind: 'no-models' })
          else setStep('model')
        }}
        onCancel={() => onDone({ kind: 'top-up' })}
      />
    </Box>
  )
}
