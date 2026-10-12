import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseFileFlag, prepareFiles } from '../../src/lib/staging.js'
import { inFolder, remoteName } from '../../src/lib/transfer.js'

describe('--file', () => {
  it('splits a destination off only when what is before the last colon is a file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orca-staging-'))
    const local = path.join(dir, 'data.csv')
    await writeFile(local, 'x')
    expect(await parseFileFlag(local)).toEqual({ path: local })
    expect(await parseFileFlag(`${local}:/workspace/in/data.csv`)).toEqual({ path: local, dest: '/workspace/in/data.csv' })
    // A drive letter is no destination.
    expect(await parseFileFlag('C:\\data.csv')).toEqual({ path: 'C:\\data.csv' })
  })

  it('puts a file at /workspace/<name> by default, and a relative destination under /workspace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orca-staging-'))
    const local = path.join(dir, 'data.csv')
    await writeFile(local, 'abc')
    expect(await prepareFiles([{ path: local }, { path: local, dest: 'in/copy.csv' }])).toEqual([
      { local, dest: '/workspace/data.csv', bytes: 3 },
      { local, dest: '/workspace/in/copy.csv', bytes: 3 },
    ])
    await expect(prepareFiles([{ path: local }, { path: local }])).rejects.toThrow('two files go to /workspace/data.csv')
  })
})

describe('remote names', () => {
  it('keep only the last part of a remote path, inside the folder', () => {
    expect(remoteName('/workspace/outputs/../../etc/passwd')).toBe('passwd')
    expect(remoteName('..\\..\\evil.txt')).toBe('evil.txt')
    for (const bad of ['/workspace/outputs/..', '/', '.', '']) expect(() => remoteName(bad)).toThrow()
    expect(inFolder('/tmp/out', '/workspace/outputs/../x.txt')).toBe(path.resolve('/tmp/out/x.txt'))
  })
})
