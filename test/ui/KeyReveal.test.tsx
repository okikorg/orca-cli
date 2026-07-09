import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { KeyReveal } from '../../src/ui/KeyReveal.js'

describe('KeyReveal', () => {
  it('renders the label header, the token, and the one-time warning, borderless', () => {
    const { lastFrame } = render(<KeyReveal token="ao_live_secretsecret00" label='Chat key for "bot" (id key_1)' />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Chat key for "bot" (id key_1)')
    expect(frame).toContain('ao_live_secretsecret00')
    expect(frame).toContain('Shown once. Store it now; it cannot be retrieved again.')
    // Borderless grammar: hierarchy from a coral header line and whitespace, no
    // box-drawing frame of any kind.
    expect(frame).not.toMatch(/[┌─┐│└┘╭╮╯╰]/)
  })

  it('falls back to a generic label when none is given', () => {
    const { lastFrame } = render(<KeyReveal token="tok" />)
    expect(lastFrame() ?? '').toContain('API key')
  })
})
