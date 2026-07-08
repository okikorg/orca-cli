import { promises as fs } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyIfUpdateAvailable, UPDATE_CHECK_TTL_MS } from '../../src/lib/update-check.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

const NOW = 1_800_000_000_000 // fixed clock; readable and stable across runs
const RELEASE = { tag_name: 'cli-v0.2.0', assets: [] }
const LATEST_ROUTE = 'GET /repos/okikorg/orca-cli/releases/latest'

let dir: string
let cleanup: () => Promise<void>

// Captures the hint line(s) notifyIfUpdateAvailable would print.
function capture(): { lines: string[]; emit: (l: string) => void } {
  const lines: string[] = []
  return { lines, emit: (l) => lines.push(l) }
}

async function writeCache(c: { checkedAt: number; latestTag: string; latest: string }): Promise<void> {
  await fs.writeFile(path.join(dir, 'update-check.json'), JSON.stringify(c))
}

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  dir = tmp.dir
  cleanup = tmp.cleanup
  delete process.env.ORCA_NO_UPDATE_CHECK
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

describe('notifyIfUpdateAvailable', () => {
  it('emits a hint when a fresh cache shows a newer version, without any network call', async () => {
    await writeCache({ checkedAt: NOW - 1000, latestTag: 'cli-v0.2.0', latest: '0.2.0' })
    const calls = stubFetch({}) // any fetch would throw and fail the test
    const { lines, emit } = capture()

    await notifyIfUpdateAvailable('0.1.0', { now: NOW, isTty: true, emit })

    expect(calls).toHaveLength(0)
    expect(lines.join('')).toContain('A newer version (cli-v0.2.0) is available')
  })

  it('says nothing when the fresh cache matches the current version', async () => {
    await writeCache({ checkedAt: NOW - 1000, latestTag: 'cli-v0.1.0', latest: '0.1.0' })
    const { lines, emit } = capture()
    await notifyIfUpdateAvailable('0.1.0', { now: NOW, isTty: true, emit })
    expect(lines).toEqual([])
  })

  it('refreshes over the network when the cache is stale, then emits and rewrites the cache', async () => {
    await writeCache({ checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1, latestTag: 'cli-v0.1.0', latest: '0.1.0' })
    const calls = stubFetch({ [LATEST_ROUTE]: jsonResponse(RELEASE) })
    const { lines, emit } = capture()

    await notifyIfUpdateAvailable('0.1.0', { now: NOW, isTty: true, emit })

    expect(calls).toHaveLength(1)
    expect(lines.join('')).toContain('cli-v0.2.0')
    const cached = JSON.parse(await fs.readFile(path.join(dir, 'update-check.json'), 'utf8'))
    expect(cached).toMatchObject({ checkedAt: NOW, latest: '0.2.0' })
  })

  it('fetches when no cache exists', async () => {
    const calls = stubFetch({ [LATEST_ROUTE]: jsonResponse(RELEASE) })
    const { lines, emit } = capture()
    await notifyIfUpdateAvailable('0.1.0', { now: NOW, isTty: true, emit })
    expect(calls).toHaveLength(1)
    expect(lines.join('')).toContain('cli-v0.2.0')
  })

  it('falls back to a stale cached version when the refresh fails (offline)', async () => {
    await writeCache({ checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1, latestTag: 'cli-v0.2.0', latest: '0.2.0' })
    stubFetch({}) // refresh throws
    const { lines, emit } = capture()
    await notifyIfUpdateAvailable('0.1.0', { now: NOW, isTty: true, emit })
    expect(lines.join('')).toContain('cli-v0.2.0')
  })

  it('does nothing when stderr is not a TTY (scripts / CI)', async () => {
    const calls = stubFetch({ [LATEST_ROUTE]: jsonResponse(RELEASE) })
    const { lines, emit } = capture()
    await notifyIfUpdateAvailable('0.1.0', { now: NOW, isTty: false, emit })
    expect(calls).toHaveLength(0)
    expect(lines).toEqual([])
  })

  it('does nothing when ORCA_NO_UPDATE_CHECK is set', async () => {
    process.env.ORCA_NO_UPDATE_CHECK = '1'
    const calls = stubFetch({ [LATEST_ROUTE]: jsonResponse(RELEASE) })
    const { lines, emit } = capture()
    await notifyIfUpdateAvailable('0.1.0', { now: NOW, isTty: true, emit })
    expect(calls).toHaveLength(0)
    expect(lines).toEqual([])
  })
})
