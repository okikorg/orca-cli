import { describe, expect, it } from 'vitest'

import {
  normalizeStoragePrefix,
  parentStoragePrefix,
  projectStorageChildren,
} from '../../src/lib/storage-paths.js'

const entries = [
  { key: 'runs/r1/out.txt', size: 42, lastModified: '2026-07-01T09:00:00Z' },
  { key: 'runs/r1/log.json', size: 1024, lastModified: '2026-07-02T10:30:00Z' },
  { key: 'runs/r2/result.md', size: 10, lastModified: '2026-07-03T08:00:00Z' },
  { key: 'runs/readme.md', size: 20, lastModified: '2026-06-30T08:00:00Z' },
  { key: 'other/ignored.txt', size: 99, lastModified: '2026-07-04T08:00:00Z' },
]

describe('storage paths', () => {
  it('normalizes folder prefixes and root', () => {
    expect(normalizeStoragePrefix()).toBe('')
    expect(normalizeStoragePrefix('/')).toBe('')
    expect(normalizeStoragePrefix('/runs/r1')).toBe('runs/r1/')
    expect(normalizeStoragePrefix('runs//r1/')).toBe('runs/r1/')
  })

  it('returns the parent folder without escaping root', () => {
    expect(parentStoragePrefix('')).toBe('')
    expect(parentStoragePrefix('runs/')).toBe('')
    expect(parentStoragePrefix('runs/r1/')).toBe('runs/')
  })

  it('projects immediate files and aggregate folders', () => {
    expect(projectStorageChildren(entries, 'runs/')).toEqual([
      {
        kind: 'directory',
        name: 'r1/',
        key: 'runs/r1/',
        size: 1066,
        objectCount: 2,
        lastModified: '2026-07-02T10:30:00Z',
      },
      {
        kind: 'directory',
        name: 'r2/',
        key: 'runs/r2/',
        size: 10,
        objectCount: 1,
        lastModified: '2026-07-03T08:00:00Z',
      },
      {
        kind: 'file',
        name: 'readme.md',
        key: 'runs/readme.md',
        size: 20,
        objectCount: 1,
        lastModified: '2026-06-30T08:00:00Z',
      },
    ])
  })
})
