import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { Field, Panel } from '../../src/ui/Panel.js'

describe('Field', () => {
  it('keeps a space between a 12-letter label and its value', () => {
    const { lastFrame } = render(<Field label="web searches" value="0 searches" />)
    expect(lastFrame()).toBe('web searches 0 searches')
  })

  it('keeps a long label on one line instead of wrapping it', () => {
    const label = '  orca/openrouter/openai/gpt-5.6-luna'
    const { lastFrame } = render(<Field label={label} value="386 tokens" />)
    expect(lastFrame()).toBe(`${label} 386 tokens`)
  })

  it('lines values up in one column for a given width', () => {
    const { lastFrame } = render(
      <Panel>
        <Field width={14} label="status" value="idle" />
        <Field width={14} label="machine time" value="0 seconds" />
      </Panel>,
    )
    const [first, second] = (lastFrame() ?? '').split('\n')
    expect(first.indexOf('idle')).toBe(second.indexOf('0 seconds'))
  })
})
