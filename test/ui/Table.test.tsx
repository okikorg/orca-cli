import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { Table, statusDot } from '../../src/ui/Table.js'
import { glyphs } from '../../src/ui/theme.js'

type Row = { name: string; runtime: string }

const cols = [
  { header: 'name', get: (r: Row) => r.name },
  { header: 'runtime', get: (r: Row) => r.runtime },
]
const data: Row[] = [
  { name: 'support-bot', runtime: 'claude' },
  { name: 'x', runtime: 'codex' },
]

describe('Table', () => {
  it('renders a bare aligned grid with no header row or rule by default', () => {
    const { lastFrame } = render(<Table<Row> columns={cols} rows={data} />)
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')
    // No uppercase label row and no rule glyph when headers is omitted.
    expect(frame).not.toContain('NAME')
    expect(frame).not.toContain(glyphs.rule)
    // Data starts on the first line and columns stay aligned across rows.
    expect(lines[0]).toContain('support-bot')
    expect(lines[0].indexOf('claude')).toBe(lines[1].indexOf('codex'))
  })

  it('renders a subtle UPPERCASE label row only when headers is set', () => {
    const { lastFrame } = render(<Table<Row> columns={cols} rows={data} headers />)
    const lines = (lastFrame() ?? '').split('\n')
    expect(lines[0]).toContain('NAME')
    expect(lines[0]).toContain('RUNTIME')
    // The label row is not underlined by a rule; data follows immediately.
    expect(lines[1]).not.toContain(glyphs.rule)
    expect(lines[1]).toContain('support-bot')
  })

  it('renders a header line from title and meta joined by the separator glyph', () => {
    const { lastFrame } = render(
      <Table<Row> columns={cols} rows={data} title="AGENTS" meta={['3', 'last 24h']} />,
    )
    const first = ((lastFrame() ?? '').split('\n'))[0]
    expect(first).toContain('AGENTS')
    expect(first).toContain(`3 ${glyphs.separator} last 24h`)
  })

  it('renders a subtle next: hint footer', () => {
    const { lastFrame } = render(
      <Table<Row> columns={cols} rows={data} hint="orca run <name>" />,
    )
    expect(lastFrame() ?? '').toContain('next: orca run <name>')
  })

  it('truncates cells that exceed the column cap', () => {
    const long = 'x'.repeat(80)
    const { lastFrame } = render(
      <Table<{ v: string }> columns={[{ header: 'v', get: (r) => r.v }]} rows={[{ v: long }]} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('...')
    expect(frame).not.toContain(long)
  })

  it('statusDot pairs the active status glyph with the status word', () => {
    expect(statusDot('running')).toBe(`${glyphs.statusFilled} running`)
    expect(statusDot('error')).toBe(`${glyphs.statusFilled} error`)
  })
})
