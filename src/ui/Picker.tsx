import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { useMemo, useState } from 'react'

import { glyphs, theme } from './theme.js'

export type PickerItem = {
  label: string
  value: string
  // Optional trailing metadata (id, status, age); rendered subtle after the
  // label so callers can pack context into a row without a second column.
  detail?: string
}

type PickerProps = {
  items: PickerItem[]
  onSubmit: (value: string) => void
  onCancel: () => void
  placeholder?: string
}

// Generic filterable single-select per the design language: type to filter,
// arrows to move, coral pointer on the active row, esc to cancel, enter to
// pick. Selection state is a coral pointer plus coral text, never an accent
// bar or inverted block. Filtering is a case-insensitive substring match on
// the label so callers get type-ahead without wiring their own predicate.
//
// TextInput owns the query text (character input, backspace); useInput owns
// navigation (arrows, enter, escape). Enter is handled here, not by TextInput,
// so an empty query never submits the raw text — it always selects a row.
export function Picker({ items, onSubmit, onCancel, placeholder }: PickerProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => it.label.toLowerCase().includes(q))
  }, [items, query])

  // Clamp the cursor into range whenever the filtered set shrinks under it.
  const active = filtered.length === 0 ? -1 : Math.min(index, filtered.length - 1)

  useInput((_input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      if (active >= 0) onSubmit(filtered[active].value)
      return
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, Math.min(i, filtered.length - 1) - 1))
      return
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(filtered.length - 1, Math.min(i, filtered.length - 1) + 1))
      return
    }
  })

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.accent}>{glyphs.pointer} </Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v)
            setIndex(0)
          }}
          placeholder={placeholder ?? 'filter'}
        />
      </Box>
      {filtered.map((it, i) => {
        const isActive = i === active
        return (
          <Box key={it.value}>
            <Text color={theme.accent}>{isActive ? `${glyphs.pointer} ` : '  '}</Text>
            <Text color={isActive ? theme.accent : undefined}>{it.label}</Text>
            {it.detail ? <Text color={theme.subtle}> {it.detail}</Text> : null}
          </Box>
        )
      })}
      <Text color={theme.subtle}>
        {filtered.length}
        {filtered.length === 1 ? ' match' : ' matches'}
        {query.trim() ? ` of ${items.length}` : ''}
      </Text>
    </Box>
  )
}
