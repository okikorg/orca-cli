import { describe, expect, it } from 'vitest'

import { renderChart } from '../src/lib/chart.js'
import { ansi } from '../src/ui/theme.js'

// Fixed width/height keep these snapshots independent of the test terminal.
describe('renderChart', () => {
  it('draws a box-drawing line chart with a right-aligned numeric axis', () => {
    const out = renderChart([0, 3, 6, 4, 8, 5, 9], { color: false, width: 40, height: 6 })
    expect(out).toBe(['9 ┤     ╭', '8 ┤   ╭╮│', '6 ┤ ╭╮│││', '5 ┤ │╰╯╰╯', '3 ┤╭╯', '2 ┤│', '0 ┼╯'].join('\n'))
  })

  it('marks the axis with ┤ ticks and a ┼ on the first point', () => {
    const out = renderChart([1, 2, 3], { color: false, width: 40 })
    // The baseline row carries the ┼ (0 is not in range here, so it is the
    // first-point cell that becomes ┼); every axis row uses ┤.
    expect(out).toContain('┼')
    expect(out).toContain('┤')
    expect(out.split('\n').every((l) => /[┼┤]/u.test(l))).toBe(true)
  })

  it('renders a single-point series without dividing by zero', () => {
    expect(renderChart([5], { color: false })).toBe('5 ┼')
  })

  it('renders an all-zero series as a flat line, not an empty box', () => {
    expect(renderChart([0, 0, 0, 0], { color: false })).toBe('0 ┼───')
  })

  it('handles negative values across a zero baseline', () => {
    const out = renderChart([-5, 0, 5], { color: false, width: 40, height: 6 })
    const lines = out.split('\n')
    // Labels are right-aligned to the widest ('-5'), so the top row reads ' 5'.
    expect(lines[0].trimStart().startsWith('5')).toBe(true)
    expect(lines[lines.length - 1].startsWith('-5')).toBe(true)
    // Zero sits on a ┼ baseline when it falls inside the range.
    expect(out).toContain('0 ┼')
  })

  it('renders the empty message (muted) instead of a chart for no finite points', () => {
    expect(renderChart([], { color: false, empty: 'No usage in this window.' })).toBe(
      'No usage in this window.',
    )
    expect(renderChart([NaN, Infinity], { color: false })).toBe('No data.')
  })

  it('appends a caption line under the chart', () => {
    const out = renderChart([1, 2, 3], { color: false, width: 40, caption: 'tokens per 15m' })
    expect(out.endsWith('\ntokens per 15m')).toBe(true)
  })

  it('clamps an over-long series to the requested plot width', () => {
    const long = Array.from({ length: 500 }, (_, i) => i)
    const out = renderChart(long, { color: false, width: 30, height: 8 })
    for (const line of out.split('\n')) {
      // strip the axis gutter (label + space + tick) then count plot columns
      const plot = line.replace(/^.*[┼┤]/u, '')
      expect(plot.length).toBeLessThanOrEqual(30)
    }
  })

  it('emits no ANSI escapes when color is disabled', () => {
    const out = renderChart([1, 5, 2, 8], { color: false, caption: 'x' })
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/)
  })

  it('paints the line coral and the axis/caption subtle when color is enabled', () => {
    const out = renderChart([1, 5, 2, 8], { color: true, caption: 'x' })
    expect(out).toContain(ansi.accent) // coral plot line
    expect(out).toContain(ansi.subtle) // subtle axis + caption
    expect(out).toContain(ansi.reset)
  })
})
