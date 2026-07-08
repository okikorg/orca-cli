import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assetNameFor,
  checkForUpdate,
  compareSemver,
  fetchLatestRelease,
  fetchReleaseByTag,
  normalizeVersion,
  parseRelease,
  parseSha256Sums,
  summarizeCheck,
  tagFor,
} from '../../src/lib/release.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

// A representative GitHub "release" payload (only the fields parseRelease reads).
const RELEASE = {
  tag_name: 'cli-v0.2.0',
  html_url: 'https://github.com/okikorg/orca-cli/releases/tag/cli-v0.2.0',
  published_at: '2026-07-08T00:00:00Z',
  assets: [
    {
      name: 'orca-darwin-arm64.tar.gz',
      browser_download_url: 'https://example.test/orca-darwin-arm64.tar.gz',
    },
    { name: 'SHA256SUMS', browser_download_url: 'https://example.test/SHA256SUMS' },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeVersion / tagFor', () => {
  it('strips a cli-v or v prefix', () => {
    expect(normalizeVersion('cli-v0.2.0')).toBe('0.2.0')
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0')
    expect(normalizeVersion('0.2.0')).toBe('0.2.0')
  })
  it('renders the release-tag form', () => {
    expect(tagFor('0.2.0')).toBe('cli-v0.2.0')
    expect(tagFor('cli-v0.2.0')).toBe('cli-v0.2.0')
  })
})

describe('compareSemver', () => {
  it('orders by numeric segments, not lexically', () => {
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1)
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1)
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0)
  })
  it('normalizes tags before comparing', () => {
    expect(compareSemver('cli-v0.2.0', '0.1.0')).toBe(1)
  })
  it('treats a missing trailing segment as zero', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0)
  })
  it('orders a release above its prerelease', () => {
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBe(1)
    expect(compareSemver('1.0.0-rc1', '1.0.0-rc2')).toBe(-1)
  })
})

describe('assetNameFor', () => {
  it('maps supported platform/arch pairs', () => {
    expect(assetNameFor('darwin', 'arm64')).toBe('orca-darwin-arm64.tar.gz')
    expect(assetNameFor('darwin', 'x64')).toBe('orca-darwin-x64.tar.gz')
    expect(assetNameFor('linux', 'x64')).toBe('orca-linux-x64.tar.gz')
    expect(assetNameFor('linux', 'arm64')).toBe('orca-linux-arm64.tar.gz')
  })
  it('maps any Windows arch to the x64 build', () => {
    expect(assetNameFor('win32', 'arm64')).toBe('orca-windows-x64.tar.gz')
  })
  it('throws for an unpublished target', () => {
    expect(() => assetNameFor('freebsd' as NodeJS.Platform, 'x64')).toThrow()
    expect(() => assetNameFor('linux', 'ia32')).toThrow()
  })
})

describe('parseSha256Sums', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const text = `${A}  orca-linux-x64.tar.gz\n${B}  orca-darwin-arm64.tar.gz\n`

  it('returns the digest for a named asset', () => {
    expect(parseSha256Sums(text, 'orca-darwin-arm64.tar.gz')).toBe(B)
  })
  it('returns null for an absent asset', () => {
    expect(parseSha256Sums(text, 'orca-windows-x64.tar.gz')).toBeNull()
  })
  it('tolerates the binary-mode * marker', () => {
    expect(parseSha256Sums(`${A}  *orca-x.tar.gz`, 'orca-x.tar.gz')).toBe(A)
  })
})

describe('parseRelease', () => {
  it('normalizes tag, version, and assets', () => {
    const r = parseRelease(RELEASE)
    expect(r.tag).toBe('cli-v0.2.0')
    expect(r.version).toBe('0.2.0')
    expect(r.assets).toHaveLength(2)
    expect(r.assets[0]).toEqual({
      name: 'orca-darwin-arm64.tar.gz',
      url: 'https://example.test/orca-darwin-arm64.tar.gz',
    })
    expect(r.publishedAt).toBe('2026-07-08T00:00:00Z')
  })
  it('throws on a payload without a tag (e.g. a rate-limit error object)', () => {
    expect(() => parseRelease({ message: 'API rate limit exceeded' })).toThrow(/tag_name/)
  })
})

describe('summarizeCheck', () => {
  it('flags an available update', () => {
    const c = summarizeCheck('0.1.0', parseRelease(RELEASE))
    expect(c).toMatchObject({
      current: '0.1.0',
      currentTag: 'cli-v0.1.0',
      latest: '0.2.0',
      latestTag: 'cli-v0.2.0',
      updateAvailable: true,
    })
  })
  it('reports up to date when equal', () => {
    const same = parseRelease({ ...RELEASE, tag_name: 'cli-v0.1.0' })
    expect(summarizeCheck('0.1.0', same).updateAvailable).toBe(false)
  })
  it('reports up to date when the local build is ahead', () => {
    expect(summarizeCheck('0.3.0', parseRelease(RELEASE)).updateAvailable).toBe(false)
  })
})

describe('fetchLatestRelease / fetchReleaseByTag', () => {
  it('fetches and parses the latest release, sending a User-Agent', async () => {
    const calls = stubFetch({
      'GET /repos/okikorg/orca-cli/releases/latest': jsonResponse(RELEASE),
    })
    const r = await fetchLatestRelease()
    expect(r.version).toBe('0.2.0')
    expect((calls[0].headers as Record<string, string>)['User-Agent']).toBe('orca-cli')
  })

  it('resolves a bare version to its cli-v tag path', async () => {
    stubFetch({
      'GET /repos/okikorg/orca-cli/releases/tags/cli-v0.2.0': jsonResponse(RELEASE),
    })
    expect((await fetchReleaseByTag('0.2.0')).tag).toBe('cli-v0.2.0')
    expect((await fetchReleaseByTag('cli-v0.2.0')).tag).toBe('cli-v0.2.0')
  })

  it('throws on a non-2xx API response', async () => {
    stubFetch({
      'GET /repos/okikorg/orca-cli/releases/latest': jsonResponse({ message: 'nope' }, { status: 404 }),
    })
    await expect(fetchLatestRelease()).rejects.toThrow(/HTTP 404/)
  })
})

describe('checkForUpdate', () => {
  it('returns a summary when reachable', async () => {
    stubFetch({ 'GET /repos/okikorg/orca-cli/releases/latest': jsonResponse(RELEASE) })
    expect(await checkForUpdate('0.1.0')).toMatchObject({ updateAvailable: true, latestTag: 'cli-v0.2.0' })
  })
  it('swallows failures and returns null (offline / rate-limited)', async () => {
    stubFetch({}) // any request throws; checkForUpdate must not
    expect(await checkForUpdate('0.1.0')).toBeNull()
  })
})
