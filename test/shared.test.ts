import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { addPageFlags, fetchAll, fetchPageOrAll, printPageHint, validatePage } from '../src/commands/shared.js'
import type { Page, PageParams } from '../src/lib/api.js'
import { ExitCode } from '../src/lib/errors.js'

// A cursor pager over ids 1..n, newest first, as the server lists them.
function pager(n: number, seen: PageParams[]) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `row_${n - i}` }))
  return async (params: PageParams): Promise<Page<{ id: string }>> => {
    seen.push(params)
    const start = params.after ? rows.findIndex((r) => r.id === params.after) + 1 : 0
    const items = rows.slice(start, start + (params.limit ?? 20))
    const hasMore = start + items.length < rows.length
    return { items, hasMore, lastId: items.at(-1)?.id ?? null }
  }
}

describe('fetchAll', () => {
  it('follows the cursor until the server has no more rows', async () => {
    const seen: PageParams[] = []
    const page = await fetchAll(pager(250, seen))
    expect(page.items).toHaveLength(250)
    expect(page.hasMore).toBe(false)
    expect(seen).toEqual([{ limit: 100 }, { limit: 100, after: 'row_151' }, { limit: 100, after: 'row_51' }])
  })

  it('makes exactly one request when the set fits in a single page', async () => {
    const seen: PageParams[] = []
    await fetchAll(pager(3, seen))
    expect(seen).toHaveLength(1)
  })
})

describe('fetchPageOrAll', () => {
  it('reads one page of --limit after the --after cursor', async () => {
    const seen: PageParams[] = []
    const page = await fetchPageOrAll({ limit: 2, after: 'row_5' }, pager(5, seen))
    expect(seen).toEqual([{ limit: 2, after: 'row_5' }])
    expect(page.items.map((r) => r.id)).toEqual(['row_4', 'row_3'])
    expect(page.lastId).toBe('row_3')
  })
})

describe('validatePage', () => {
  it('rejects a limit outside 1 to 100', () => {
    expect(() => validatePage({ limit: 0 })).toThrow(expect.objectContaining({ exitCode: ExitCode.Usage }))
    expect(() => validatePage({ limit: 101 })).toThrow(expect.objectContaining({ exitCode: ExitCode.Usage }))
    expect(() => validatePage({ limit: 100 })).not.toThrow()
  })

  it('rejects --all with an explicit --limit or --after', () => {
    const cmd = addPageFlags(new Command('x')).exitOverride()
    cmd.parse(['--all', '--limit', '5'], { from: 'user' })
    expect(() => validatePage(cmd.opts(), cmd)).toThrow(expect.objectContaining({ exitCode: ExitCode.Usage }))
    expect(() => validatePage({ all: true, after: 'row_1' })).toThrow(
      expect.objectContaining({ exitCode: ExitCode.Usage }),
    )
  })

  it('accepts --all alone, ignoring the default limit', () => {
    const cmd = addPageFlags(new Command('x')).exitOverride()
    cmd.parse(['--all'], { from: 'user' })
    expect(() => validatePage(cmd.opts(), cmd)).not.toThrow()
  })
})

describe('printPageHint', () => {
  it('names the next cursor on stderr when more rows exist', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    printPageHint({ items: [{}], hasMore: true, lastId: 'row_9' })
    expect(spy.mock.calls.flat().join(' ')).toContain('--after row_9')
    spy.mockRestore()
  })

  it('stays silent on the last page', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    printPageHint({ items: [{}], hasMore: false, lastId: 'row_9' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
