import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { registerFiles } from '../../src/commands/files.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const FILE = {
  id: 'file_1',
  object: 'file',
  bytes: 5,
  created_at: 1_783_245_600,
  filename: 'data.bin',
  purpose: 'user_data',
  status: 'processed',
}

const { run, stdout } = commandHarness(registerFiles)

describe('files', () => {
  it('lists files in plain mode', async () => {
    stubFetch({ 'GET /v1/files?limit=10': jsonResponse(list([FILE])) })
    await run(['files', 'list'])
    expect(stdout()).toBe('file_1\tdata.bin\t5\t2026-07-05 10:00\n')
  })

  it('uploads a file as user_data multipart and prints its id when piped', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orca-files-'))
    const local = path.join(dir, 'data.bin')
    await writeFile(local, Buffer.from([0, 1, 2, 255, 42]))
    const calls = stubFetch({ 'POST /v1/files': jsonResponse(FILE) })
    await run(['files', 'upload', local])
    const form = calls[0].form
    expect(form?.get('purpose')).toBe('user_data')
    const part = form?.get('file') as File
    expect(part.name).toBe('data.bin')
    expect(Buffer.from(await part.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255, 42]))
    expect(stdout()).toBe('file_1\n')
  })

  it('refuses a path that is not a file before any request', async () => {
    const calls = stubFetch({})
    await expect(run(['files', 'upload', os.tmpdir()])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('downloads the bytes to --output', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orca-files-'))
    const dest = path.join(dir, 'out.bin')
    stubFetch({
      'GET /v1/files/file_1/content': () =>
        new Response(new Uint8Array([0, 1, 2, 255, 42]), { headers: { 'Content-Type': 'application/octet-stream' } }),
    })
    await run(['files', 'download', 'file_1', '-o', dest])
    expect(await readFile(dest)).toEqual(Buffer.from([0, 1, 2, 255, 42]))
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({ 'DELETE /v1/files/file_1': jsonResponse({ id: 'file_1', object: 'file', deleted: true }) })
    await run(['files', 'delete', 'file_1', '--yes'])
    expect(calls).toHaveLength(1)
  })

  it('reports a missing file as not found', async () => {
    stubFetch({
      'DELETE /v1/files/file_9': jsonResponse({ error: { message: 'Resource not found' } }, { status: 404 }),
    })
    await expect(run(['files', 'delete', 'file_9', '--yes'])).rejects.toMatchObject({ exitCode: ExitCode.NotFound })
  })
})
