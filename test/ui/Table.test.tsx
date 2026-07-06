import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { Table } from '../../src/ui/Table.js'

type Row = { name: string; runtime: string }

describe('Table', () => {
  it('renders uppercase headers and aligned columns', () => {
    const { lastFrame } = render(
      <Table<Row>
        columns={[
          { header: 'name', get: (r) => r.name },
          { header: 'runtime', get: (r) => r.runtime },
        ]}
        rows={[
          { name: 'support-bot', runtime: 'claude' },
          { name: 'x', runtime: 'codex' },
        ]}
      />,
    )
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')
    expect(lines[0]).toContain('NAME')
    expect(lines[0]).toContain('RUNTIME')
    // A subtle rule sits under the header (line index 1), data starts at 2.
    expect(lines[1]).toContain('─')
    expect(lines[2].indexOf('claude')).toBe(lines[3].indexOf('codex'))
  })

  it('truncates cells that exceed the column cap', () => {
    const long = 'x'.repeat(80)
    const { lastFrame } = render(
      <Table<{ v: string }>
        columns={[{ header: 'v', get: (r) => r.v }]}
        rows={[{ v: long }]}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('...')
    expect(frame).not.toContain(long)
  })
})
