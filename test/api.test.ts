import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiClient, ApiError, extractErrorBody, mapApiError } from '../src/lib/api.js'
import { ExitCode } from '../src/lib/errors.js'
import { jsonResponse, stubFetch } from './helpers/fetch-mock.js'

const OPTS = { apiUrl: 'http://test:8080', apiKey: 'ao_dev_k'.padEnd(30, 'x'), contextName: 'test' }

function client() {
  return new ApiClient(OPTS)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiClient.request', () => {
  it('sends the bearer key and parses JSON', async () => {
    const calls = stubFetch({
      'GET /api/profiles/orca': jsonResponse({ name: 'orca', runtime: 'claude' }),
    })
    const profile = await client().getProfile('orca')
    expect(profile.name).toBe('orca')
    expect(calls[0].headers.Authorization).toBe(`Bearer ${OPTS.apiKey}`)
    expect(calls[0].headers['X-Tenant-ID']).toBeUndefined()
  })

  it('returns undefined for empty bodies', async () => {
    stubFetch({ 'DELETE /api/profiles/orca': () => new Response(null, { status: 204 }) })
    await expect(client().deleteProfile('orca')).resolves.toBeUndefined()
  })

  it('throws ApiError with the parsed body on 4xx', async () => {
    stubFetch({
      'POST /api/profiles': jsonResponse({ error: 'invalid body: name required' }, { status: 400 }),
    })
    const err = await client()
      .createProfile({ name: '', runtime: 'claude' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
    expect(extractErrorBody((err as ApiError).body)).toBe('invalid body: name required')
  })

  it('strips trailing slashes from the base URL', async () => {
    const calls = stubFetch({ 'GET /api/runs': jsonResponse([]) })
    const c = new ApiClient({ ...OPTS, apiUrl: 'http://test:8080///' })
    await c.listRuns()
    expect(calls).toHaveLength(1)
  })
})

describe('ApiClient.requestPaged', () => {
  it('reads X-Total-Count', async () => {
    stubFetch({
      'GET /api/profiles?limit=2': jsonResponse([{ name: 'a' }, { name: 'b' }], {
        headers: { 'X-Total-Count': '41' },
      }),
    })
    const page = await client().listProfiles({ limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(41)
  })

  it('falls back to array length without the header', async () => {
    stubFetch({ 'GET /api/profiles': jsonResponse([{ name: 'a' }]) })
    const page = await client().listProfiles()
    expect(page.total).toBe(1)
  })

  it('forwards limit and offset as query params', async () => {
    const calls = stubFetch({ 'GET /api/runs?limit=5&offset=10': jsonResponse([]) })
    await client().listRuns({ limit: 5, offset: 10 })
    expect(calls[0].path).toBe('/api/runs?limit=5&offset=10')
  })

  it('passes the sessions ?q= filter alongside pagination', async () => {
    const calls = stubFetch({ 'GET /api/sessions?limit=25&q=triage': jsonResponse([]) })
    await client().listSessions({ limit: 25, q: 'triage' })
    expect(calls[0].path).toBe('/api/sessions?limit=25&q=triage')
  })

  it('passes the sessions ?profile= exact filter alongside pagination', async () => {
    const calls = stubFetch({ 'GET /api/sessions?limit=25&profile=dev': jsonResponse([]) })
    await client().listSessions({ limit: 25, profile: 'dev' })
    expect(calls[0].path).toBe('/api/sessions?limit=25&profile=dev')
  })
})

describe('ApiClient.requestPagedField', () => {
  it('unwraps the envelope array and reads X-Total-Count', async () => {
    stubFetch({
      'GET /api/secrets?limit=2': jsonResponse(
        { total: 2, secrets: [{ name: 'A' }, { name: 'B' }] },
        { headers: { 'X-Total-Count': '30' } },
      ),
    })
    const page = await client().listSecrets({ limit: 2 })
    expect(page.items).toEqual([{ name: 'A' }, { name: 'B' }])
    expect(page.total).toBe(30)
  })

  it('falls back to the envelope total when the header is absent', async () => {
    stubFetch({
      'GET /api/published': jsonResponse({
        publishedAgents: [{ profileName: 'a', publicUrl: 'https://x' }],
        total: 7,
      }),
    })
    const page = await client().listPublishedAgents()
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(7)
  })

  it('falls back to the array length when neither header nor total is present', async () => {
    stubFetch({
      'GET /api/profiles/bot/keys': jsonResponse({ keys: [{ id: 'k1' }] }),
    })
    const page = await client().listAgentKeys('bot')
    expect(page.total).toBe(1)
  })
})

describe('mapApiError', () => {
  const opts = { contextName: 'test', apiUrl: 'http://test:8080' }

  it('maps 401 to the auth exit code with a login hint', () => {
    const e = mapApiError(new ApiError('401', 401), opts)
    expect(e.exitCode).toBe(ExitCode.Auth)
    expect(e.message).toContain('test')
  })

  it('maps 403 to the auth exit code', () => {
    expect(mapApiError(new ApiError('403', 403), opts).exitCode).toBe(ExitCode.Auth)
  })

  it('maps 404 to the not-found exit code', () => {
    const e = mapApiError(new ApiError('404', 404, { error: 'unknown_profile: x' }), opts)
    expect(e.exitCode).toBe(ExitCode.NotFound)
    expect(e.message).toContain('unknown_profile: x')
  })

  it('surfaces the structured reason on other 4xx', () => {
    const e = mapApiError(new ApiError('400', 400, { error: 'profile required' }), opts)
    expect(e.exitCode).toBe(ExitCode.Failure)
    expect(e.message).toBe('400: profile required')
  })

  it('maps 5xx to a retry message', () => {
    expect(mapApiError(new ApiError('502', 502), opts).message).toContain('502')
  })

  it('maps fetch TypeError to a connectivity message', () => {
    const e = mapApiError(new TypeError('fetch failed'), opts)
    expect(e.message).toContain('http://test:8080')
  })
})
