import { describe, expect, it } from 'vitest'

import { CliError, ExitCode } from '../../src/lib/errors.js'
import { assertWindow } from '../../src/lib/window.js'

describe('assertWindow', () => {
  it('accepts the documented windows unchanged', () => {
    for (const w of ['1h', '24h', '7d', '30d']) {
      expect(assertWindow(w)).toBe(w)
    }
  })

  it('accepts the permissive unit superset (minutes, weeks, multi-digit)', () => {
    for (const w of ['15m', '2w', '90d', '360h']) {
      expect(assertWindow(w)).toBe(w)
    }
  })

  it('rejects a non-window string with exit 2', () => {
    expect(() => assertWindow('bogus')).toThrow(CliError)
    try {
      assertWindow('bogus')
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.Usage)
    }
  })

  it('rejects a bare number, a bad unit, and a leading unit', () => {
    for (const w of ['7', 'd7', '7x', '7 d', '']) {
      expect(() => assertWindow(w)).toThrow(CliError)
    }
  })

  it('rejects a zero-length window', () => {
    expect(() => assertWindow('0h')).toThrow(/greater than zero/)
    expect(() => assertWindow('00d')).toThrow(/greater than zero/)
  })
})
