import { Box, Text } from 'ink'
import { useState } from 'react'

import { SWITCH_WARNING, type SwitchCause } from '../lib/models.js'
import { Picker, type PickerItem } from './Picker.js'
import { theme } from './theme.js'

// What the other side of who pays offers a session: its models, the one to
// preselect (the same OpenRouter model, if listed), and the provider whose
// account ran out, for the wording. freeModel is set when the free model
// leads the list (free-plan D3.16).
export type SwitchOffer = { items: PickerItem[]; initial?: string; provider: string | null; freeModel?: boolean }

// How the prompt ended: a model to switch to, the other way instead (a
// top-up, an upgrade, or neither), or no model on the other side to switch
// to.
export type SwitchChoice = { kind: 'switch'; model: string } | { kind: 'top-up' } | { kind: 'no-models' }

type SwitchPromptProps = {
  out: SwitchCause
  offer: SwitchOffer
  onDone: (choice: SwitchChoice) => void
}

// switchLabel names what the switch offers: the free model first when it
// leads the list, else the other side of who pays.
function switchLabel(out: SwitchCause, offer: SwitchOffer): string {
  if (out === 'provider_quota') return 'Switch this session to Orca credit'
  return offer.freeModel ? 'Switch this session to the free model or your own key' : 'Switch this session to your own key'
}

// otherWay is the question and the choice beside the switch: a top-up for a
// credit that ran out, an upgrade for a model not in the organization's
// plan (free-plan D3.16), and for a free model withdrawn, keeping the
// session as it is (amendment A3 (3)).
function otherWay(out: SwitchCause, offer: SwitchOffer): { question: string; label: string } {
  switch (out) {
    case 'orca_credit':
      return { question: 'Top up, or switch this session?', label: 'Top up first (orca billing wallet)' }
    case 'provider_quota':
      return { question: 'Top up, or switch this session?', label: `Top up at ${offer.provider ?? 'your provider'} first` }
    case 'model_not_in_plan':
      return { question: 'Upgrade, or switch this session?', label: 'Upgrade first (orca billing buy pro, or orca billing buy max)' }
    case 'free_model_unavailable':
      return { question: 'Switch this session?', label: 'Not now' }
  }
}

// The switch of who pays after a credit ran out (orca-design model-billing
// D3.13), or of model after a plan refusal: the design's warning, then
// "top up, or switch this session?" (or the plan's question), then the
// other side's models. One component for both steps, so the REPL and a
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
  const other = otherWay(out, offer)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>{SWITCH_WARNING}</Text>
      <Text bold>{other.question}</Text>
      <Picker
        items={[
          { label: switchLabel(out, offer), value: 'switch' },
          { label: other.label, value: 'top-up' },
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
