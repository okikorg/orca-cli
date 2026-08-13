import { describe, expect, it } from 'vitest'

import {
  buildArgs,
  DEFAULT_PLATFORM,
  dockerAvailable,
  DockerError,
  repositoryOf,
  resolveDigest,
  type Exec,
} from '../../src/lib/docker.js'

const DIGEST = 'sha256:' + 'a'.repeat(64)

// recordingExec captures the argv every call was made with, so the tests
// assert what docker would have been asked to do without docker installed.
function recordingExec(stdout = ''): Exec & { calls: string[][] } {
  const calls: string[][] = []
  const fn = async (file: string, args: string[]) => {
    calls.push([file, ...args])
    return { stdout, stderr: '' }
  }
  return Object.assign(fn, { calls })
}

describe('buildArgs', () => {
  it('pins the platform even when the caller passes none', () => {
    // A build on Apple Silicon defaults to arm64, which imports fine and then
    // fails at first boot. The default is the whole point of this wrapper.
    const args = buildArgs({ context: '/w/h', tag: 'ghcr.io/a/h:t' })
    expect(args).toEqual(['build', '--platform', DEFAULT_PLATFORM, '-t', 'ghcr.io/a/h:t', '/w/h'])
    expect(DEFAULT_PLATFORM).toBe('linux/amd64')
  })

  it('honours an explicit platform', () => {
    const args = buildArgs({ context: '.', tag: 't', platform: 'linux/arm64' })
    expect(args).toContain('linux/arm64')
    expect(args).not.toContain('linux/amd64')
  })

  it('passes the Dockerfile and cache flags through, context last', () => {
    const args = buildArgs({ context: '/w/h', tag: 't', file: '/w/h/Dockerfile.dev', noCache: true })
    expect(args).toContain('-f')
    expect(args).toContain('/w/h/Dockerfile.dev')
    expect(args).toContain('--no-cache')
    expect(args[args.length - 1]).toBe('/w/h')
  })
})

describe('repositoryOf', () => {
  it('strips a tag', () => {
    expect(repositoryOf('ghcr.io/acme/h:v1')).toBe('ghcr.io/acme/h')
  })

  it('strips a digest', () => {
    expect(repositoryOf(`ghcr.io/acme/h@${DIGEST}`)).toBe('ghcr.io/acme/h')
  })

  it('keeps a registry port, which is not a tag separator', () => {
    expect(repositoryOf('localhost:5000/acme/h:v1')).toBe('localhost:5000/acme/h')
    expect(repositoryOf('localhost:5000/acme/h')).toBe('localhost:5000/acme/h')
  })
})

describe('resolveDigest', () => {
  it('picks the digest for the target repository, not the first one listed', async () => {
    // An image pushed to two repositories has two RepoDigests, and their
    // order is docker's business. Taking index 0 would hand the platform a
    // reference into somebody else's repository.
    const other = 'sha256:' + 'b'.repeat(64)
    const exec = recordingExec(
      `docker.io/other/h@${other}\nghcr.io/acme/h@${DIGEST}\n`,
    )
    const got = await resolveDigest('ghcr.io/acme/h:v1', exec)
    expect(got).toBe(`ghcr.io/acme/h@${DIGEST}`)
  })

  it('says the image has not been pushed when there are no repo digests', async () => {
    const exec = recordingExec('')
    await expect(resolveDigest('ghcr.io/acme/h:v1', exec)).rejects.toBeInstanceOf(DockerError)
    await expect(resolveDigest('ghcr.io/acme/h:v1', exec)).rejects.toThrow(/has not been pushed/)
  })

  it('reports the digests it did find when none match the repository', async () => {
    const other = 'sha256:' + 'b'.repeat(64)
    const exec = recordingExec(`docker.io/other/h@${other}\n`)
    await expect(resolveDigest('ghcr.io/acme/h:v1', exec)).rejects.toThrow(/docker.io\/other\/h/)
  })
})

describe('dockerAvailable', () => {
  it('is false when docker cannot be executed', async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    }
    expect(await dockerAvailable(exec)).toBe(false)
  })

  it('is true when docker answers', async () => {
    expect(await dockerAvailable(recordingExec('27.0.0'))).toBe(true)
  })
})
