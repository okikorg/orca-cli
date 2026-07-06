// Pure ASCII line-chart renderer, in the visual style of guptarohit/asciigraph
// and kroitor/asciichart: a box-drawing plot with a right-aligned numeric
// y-axis and tick marks. Ported (not depended-on) so we control axis-label
// precision, width clamping, and Orca theming.
//
// This module is deliberately free of any Ink import so it stays a pure,
// unit-testable `(series, opts) => string`. The Ink views embed its output
// verbatim in a <Text> block. A later stats command is expected to reuse it,
// so keep the surface generic (no usage-specific vocabulary leaks in here).

import { ansi, colorEnabled } from '../ui/theme.js'

export interface ChartOptions {
  // Plot height in rows (before axis). Defaults to 10.
  height?: number
  // Max plot columns (data points shown). Longer series are averaged down to
  // fit. Defaults to a terminal-adaptive width, capped at 72, floored at 20.
  width?: number
  // Emit ANSI color (coral line, subtle axis/caption). Defaults to
  // colorEnabled() so NO_COLOR / non-TTY produce plain output.
  color?: boolean
  // A subtle one-line caption printed under the chart.
  caption?: string
  // Message rendered (muted) when the series has no finite points, instead of
  // an empty plot. Defaults to 'No data.'.
  empty?: string
  // Override the y-axis label formatter. Receives the raw axis value.
  format?: (value: number) => string
}

const LINE_GLYPHS = new Set(['─', '╰', '╭', '╮', '╯', '│', '┼'])

type CellClass = 'line' | 'axis' | null

interface Cell {
  ch: string
  cls: CellClass
}

// resample averages an over-long series down to `target` columns so a 30d
// window (hundreds of buckets) still fits the plot. Shorter series pass
// through untouched.
function resample(series: number[], target: number): number[] {
  if (series.length <= target) return series
  const out: number[] = []
  const step = series.length / target
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * step)
    const end = Math.max(start + 1, Math.floor((i + 1) * step))
    let sum = 0
    let n = 0
    for (let j = start; j < end && j < series.length; j++) {
      sum += series[j]
      n++
    }
    out.push(n > 0 ? sum / n : 0)
  }
  return out
}

// defaultFormatter picks a decimal precision from the series magnitude so we
// never print 12-decimal axis labels: integers stay integers, small
// fractional series (e.g. dollars) get a few decimals.
function defaultFormatter(series: number[]): (v: number) => string {
  const allInt = series.every((v) => Number.isInteger(v))
  const maxAbs = series.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  let decimals: number
  if (allInt) decimals = 0
  else if (maxAbs >= 100) decimals = 0
  else if (maxAbs >= 1) decimals = 1
  else decimals = 3
  return (v: number) => v.toFixed(decimals)
}

function paintRun(text: string, cls: CellClass, color: boolean): string {
  if (!text) return ''
  if (!color || cls === null) return text
  const code = cls === 'line' ? ansi.accent : ansi.subtle
  return `${code}${text}${ansi.reset}`
}

// serialize joins the cell grid into colored lines, grouping adjacent cells of
// the same color class into a single escape run (so we don't reset on every
// glyph). Trailing spaces are dropped to keep the output tidy.
function serialize(grid: Cell[][], color: boolean): string[] {
  return grid.map((row) => {
    let out = ''
    let buf = ''
    let cur: CellClass = null
    for (const cell of row) {
      const cls: CellClass = cell.ch === ' ' ? null : cell.cls
      if (cls !== cur) {
        out += paintRun(buf, cur, color)
        buf = ''
        cur = cls
      }
      buf += cell.ch
    }
    out += paintRun(buf, cur, color)
    return out.replace(/\s+$/u, '')
  })
}

function defaultWidth(): number {
  const cols = process.stdout.columns || 80
  return Math.min(72, Math.max(20, cols - 12))
}

// renderChart returns a multi-line string: a box-drawing line chart with a
// right-aligned numeric y-axis, optional caption, themed for the terminal.
export function renderChart(series: number[], opts: ChartOptions = {}): string {
  const color = opts.color ?? colorEnabled()
  const finite = series.filter((v) => Number.isFinite(v))
  const caption = opts.caption
    ? '\n' + paintRun(opts.caption, 'axis', color)
    : ''

  if (finite.length === 0) {
    const msg = opts.empty ?? 'No data.'
    return paintRun(msg, 'axis', color) + caption
  }

  const data = resample(finite, opts.width ?? defaultWidth())
  const format = opts.format ?? defaultFormatter(data)

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min
  const height = Math.max(1, opts.height ?? 10)
  const ratio = range !== 0 ? height / range : 1
  const min2 = Math.round(min * ratio)
  const max2 = Math.round(max * ratio)
  const rows = Math.max(0, max2 - min2)

  // Row 0 is the top (value = max), row `rows` the bottom (value = min).
  const rowValue = (i: number): number => max - (i * range) / (rows || 1)
  const rowLabels: string[] = []
  for (let i = 0; i <= rows; i++) rowLabels.push(format(rowValue(i)))
  const labelWidth = rowLabels.reduce((m, l) => Math.max(m, l.length), 0)
  const tickCol = labelWidth + 1 // one space between the label and the tick
  const gutter = tickCol + 1 // plot begins just right of the tick
  const totalCols = gutter + data.length

  const grid: Cell[][] = []
  for (let i = 0; i <= rows; i++) {
    const row: Cell[] = new Array(totalCols)
    for (let c = 0; c < totalCols; c++) row[c] = { ch: ' ', cls: null }
    // Right-align the axis label in the gutter.
    const label = rowLabels[i]
    const start = labelWidth - label.length
    for (let k = 0; k < label.length; k++) row[start + k] = { ch: label[k], cls: 'axis' }
    // Tick: ┼ on the zero baseline (when 0 is in range), else ┤.
    const baselineRow = rows + min2 // row index where value == 0
    const tick = baselineRow >= 0 && baselineRow <= rows && i === baselineRow ? '┼' : '┤'
    row[tickCol] = { ch: tick, cls: 'axis' }
    grid.push(row)
  }

  const scaled = (v: number): number => rows - (Math.round(v * ratio) - min2)
  const plot = (r: number, c: number, ch: string): void => {
    if (r < 0 || r > rows || c < 0 || c >= totalCols) return
    grid[r][c] = { ch, cls: LINE_GLYPHS.has(ch) ? 'line' : 'axis' }
  }

  // First data point sits on the axis as a ┼.
  plot(scaled(data[0]), gutter - 1, '┼')
  for (let x = 0; x < data.length - 1; x++) {
    const y0 = scaled(data[x])
    const y1 = scaled(data[x + 1])
    const col = gutter + x
    if (y0 === y1) {
      plot(y0, col, '─')
    } else {
      // Row indices count from the top, so y0 > y1 means the value rose.
      plot(y1, col, y0 > y1 ? '╭' : '╰')
      plot(y0, col, y0 > y1 ? '╯' : '╮')
      const from = Math.min(y0, y1)
      const to = Math.max(y0, y1)
      for (let y = from + 1; y < to; y++) plot(y, col, '│')
    }
  }

  return serialize(grid, color).join('\n') + caption
}
