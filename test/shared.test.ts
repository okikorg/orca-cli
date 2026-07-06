import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { addPageFlags, fetchAll, fetchPageOrAll, validatePage } from '../src/commands/shared.js'
import type { Paged, PageParams } from '../src/lib/api.js'
import { ExitCode } from '../src/lib/errors.js'

describe('fetchAll', () => {
  it('walks every page and concatenates the rows in order', async () => {
    // A 450-row set served in 200 / 200 / 50 pages.
    const rows = Array.from({ length: 450 }, (_, i) => i)
    const seen: PageParams[] = []
    const pager = async (params: PageParams): Promise<Paged<number>> => {
      seen.push(params)
      const offset = params.offset ?? 0
      const limit = params.limit ?? 200
      return { items: rows.slice(offset, offset + limit), total: rows.length }
    }
    const page = await fetchAll(pager)
    expect(page.items).toEqual(rows)
    expect(page.total).toBe(450)
    // The first request omits offset; later requests advance by the page size.
    expect(seen).toEqual([
      { limit: 200 },
      { limit: 200, offset: 200 },
      { limit: 200, offset: 400 },
    ])
  })

  it('makes exactly one request when the set fits in a single page', async () => {
    let calls = 0
    const pager = async (): Promise<Paged<number>> => {
      calls++
      return { items: [1, 2, 3], total: 3 }
    }
    const page = await fetchAll(pager)
    expect(page.items).toEqual([1, 2, 3])
    expect(calls).toBe(1)
  })

  it('stops at the 10000-row safety cap and warns on stderr', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Report far more rows than the cap and always return full pages.
    const pager = async (params: PageParams): Promise<Paged<number>> => {
      const offset = params.offset ?? 0
      return { items: Array.from({ length: 200 }, (_, i) => offset + i), total: 20000 }
    }
    const page = await fetchAll(pager)
    expect(page.items).toHaveLength(10000)
    expect(page.total).toBe(10000)
    expect(warn.mock.calls.join(' ')).toContain('10000')
    warn.mockRestore()
  })
})

describe('fetchPageOrAll against servers that predate pagination', () => {
  // Old servers ignore limit/offset and return the whole set; the client must
  // emulate the requested window so list commands never dump everything.
  const rows = Array.from({ length: 142 }, (_, i) => i)
  const oldServer = async (): Promise<Paged<number>> => ({ items: rows, total: rows.length })

  it('emulates the default window client-side when the server over-returns', async () => {
    const page = await fetchPageOrAll({ limit: 50 }, oldServer)
    expect(page.items).toEqual(rows.slice(0, 50))
    expect(page.total).toBe(142)
  })

  it('emulates limit and offset together', async () => {
    const page = await fetchPageOrAll({ limit: 10, offset: 20 }, oldServer)
    expect(page.items).toEqual(rows.slice(20, 30))
    expect(page.total).toBe(142)
  })

  it('leaves honored pages untouched', async () => {
    const honored = async (params: PageParams): Promise<Paged<number>> => ({
      items: rows.slice(0, params.limit ?? 50),
      total: rows.length,
    })
    const page = await fetchPageOrAll({ limit: 50 }, honored)
    expect(page.items).toHaveLength(50)
    expect(page.total).toBe(142)
  })
})

describe('validatePage with --all', () => {
  function parse(args: string[]): Command {
    const cmd = new Command('list').exitOverride()
    addPageFlags(cmd)
    cmd.action(() => {})
    cmd.parse(args, { from: 'user' })
    return cmd
  }

  it('rejects --all combined with an explicit --limit as a usage error', () => {
    const cmd = parse(['--all', '--limit', '10'])
    let caught: unknown
    try {
      validatePage(cmd.opts(), cmd)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('accepts --all when --limit is left at its default', () => {
    const cmd = parse(['--all'])
    expect(() => validatePage(cmd.opts(), cmd)).not.toThrow()
  })
})
