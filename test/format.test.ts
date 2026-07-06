import { describe, expect, it } from 'vitest'

import { formatDuration, formatTimestamp } from '../src/lib/format.js'

describe('formatTimestamp', () => {
  it('compacts a normal ISO timestamp to minute precision', () => {
    expect(formatTimestamp('2026-07-05T10:00:00Z')).toBe('2026-07-05 10:00')
  })

  it('handles the conductor nanosecond-with-trailing-marker format', () => {
    expect(formatTimestamp('2026-07-05T09:57:32.354596652s')).toBe('2026-07-05 09:57')
  })

  it('accepts a space separator', () => {
    expect(formatTimestamp('2026-07-05 09:57:32')).toBe('2026-07-05 09:57')
  })

  it('falls back to a clipped string for unrecognized input', () => {
    expect(formatTimestamp('not-a-timestamp-value-here')).toBe('not-a-timestamp-')
  })
})

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration('2026-07-05T10:00:00Z', '2026-07-05T10:00:30Z')).toBe('30s')
  })

  it('renders minutes and seconds', () => {
    expect(formatDuration('2026-07-05T10:00:00Z', '2026-07-05T10:02:05Z')).toBe('2m5s')
  })
})
