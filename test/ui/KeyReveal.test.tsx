import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { KeyReveal } from '../../src/ui/KeyReveal.js'

describe('KeyReveal', () => {
  it('frames the token and label in the shared Panel border, with the one-time warning', () => {
    const { lastFrame } = render(<KeyReveal token="ao_live_secretsecret00" label='Chat key for "bot" (id key_1)' />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Chat key for "bot" (id key_1)')
    expect(frame).toContain('ao_live_secretsecret00')
    expect(frame).toContain('Shown once. Store it now; it cannot be retrieved again.')
    // Panel's single-line border, not a rounded/double frame or an
    // accent-bar left border.
    expect(frame).toMatch(/[┌─┐]/)
  })

  it('falls back to a generic label when none is given', () => {
    const { lastFrame } = render(<KeyReveal token="tok" />)
    expect(lastFrame() ?? '').toContain('API key')
  })
})
