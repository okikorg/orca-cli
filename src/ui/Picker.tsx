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
  // The value the pointer starts on, when it is among the items.
  initial?: string
}

// At most this many rows are drawn, a window that follows the pointer, so a
// long list (a provider's model catalog) never floods the terminal. The
// match count says how many there are.
const VISIBLE_ROWS = 10

// Generic filterable single-select per the design language: type to filter,
// arrows to move, mint pointer on the active row, esc to cancel, enter to
// pick. Selection state is a mint pointer plus mint text, never an accent
// bar or inverted block. Filtering is a case-insensitive substring match on
// the label or the detail so callers get type-ahead without wiring their own
// predicate.
//
// TextInput owns the query text (character input, backspace); useInput owns
// navigation (arrows, enter, escape). Enter is handled here, not by TextInput,
// so an empty query never submits the raw text: it always selects a row.
export function Picker({ items, onSubmit, onCancel, placeholder, initial }: PickerProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((it) => it.value === initial)))

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => it.label.toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q))
  }, [items, query])

  // Clamp the cursor into range whenever the filtered set shrinks under it.
  const active = filtered.length === 0 ? -1 : Math.min(index, filtered.length - 1)
  const start = Math.min(Math.max(0, active - Math.floor(VISIBLE_ROWS / 2)), Math.max(0, filtered.length - VISIBLE_ROWS))
  const shown = filtered.slice(start, start + VISIBLE_ROWS)

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
      {shown.map((it, offset) => {
        const isActive = start + offset === active
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
