import { APIConnectionError, APIError as OpenAIAPIError } from 'openai/error'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiClient, ApiError, extractErrorBody, mapApiError, pageQuery, toPage } from '../src/lib/api.js'
import { ExitCode } from '../src/lib/errors.js'
import { jsonResponse, stubFetch } from './helpers/fetch-mock.js'

const OPTS = { apiUrl: 'http://test:8080/', apiKey: 'orca_sk_'.padEnd(60, 'x'), contextName: 'test' }
const CTX = { contextName: 'test', apiUrl: 'http://test:8080' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiClient.request', () => {
  it('sends the bearer key to /api and parses JSON', async () => {
    const calls = stubFetch({
      'GET /api/whoami': jsonResponse({ object: 'whoami', tenant: 'org_1', actor: 'user_1', role: 'admin' }),
    })
    const who = await new ApiClient(OPTS).whoami()
    expect(who.tenant).toBe('org_1')
    expect(calls[0].headers.Authorization).toBe(`Bearer ${OPTS.apiKey}`)
  })

  it('sends no Authorization header without a key', async () => {
    const calls = stubFetch({ 'GET /api/public/kits/kit-abcdefghijklmnopq': jsonResponse({ object: 'kit.public' }) })
    await new ApiClient({ ...OPTS, apiKey: '' }).publicKit('kit-abcdefghijklmnopq')
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('throws ApiError with the parsed body on 4xx', async () => {
    stubFetch({
      'POST /api/keys': jsonResponse(
        { error: { message: 'name must be a string', type: 'invalid_request_error', param: 'name', code: 'invalid_request' } },
        { status: 400 },
      ),
    })
    const err = await new ApiClient(OPTS).createKey('').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
    expect(extractErrorBody((err as ApiError).body)).toBe('name must be a string')
  })

  it('reads list envelopes into cursor pages', async () => {
    stubFetch({
      'GET /api/keys?limit=2': jsonResponse({
        object: 'list',
        data: [{ id: 'key_2' }, { id: 'key_1' }],
        has_more: true,
        first_id: 'key_2',
        last_id: 'key_1',
      }),
    })
    const page = await new ApiClient(OPTS).listKeys({ limit: 2 })
    expect(page.hasMore).toBe(true)
    expect(page.lastId).toBe('key_1')
  })
})

describe('v1()', () => {
  it('points the openai client at /v1 with the same key, and reuses it', async () => {
    const calls = stubFetch({
      'GET /v1/agents?limit=1': jsonResponse({ object: 'list', data: [], has_more: false, first_id: null, last_id: null }),
    })
    const client = new ApiClient(OPTS)
    const v1 = await client.v1()
    expect(await client.v1()).toBe(v1)
    await v1.beta.agents.list({ limit: 1 })
    expect(calls[0].host).toBe('test:8080')
    expect(new Headers(calls[0].headers as ConstructorParameters<typeof Headers>[0]).get('authorization')).toBe(`Bearer ${OPTS.apiKey}`)
  })
})

describe('helpers', () => {
  it('pageQuery skips empty values', () => {
    expect(pageQuery({ limit: 5, after: undefined, meter: '' })).toBe('?limit=5')
    expect(pageQuery()).toBe('')
  })

  it('toPage takes the cursor from the last row', () => {
    expect(toPage({ data: [{ id: 'a' }, { id: 'b' }], has_more: false })).toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      hasMore: false,
      lastId: 'b',
    })
  })

  it('extractErrorBody reads the server error object, the device flow code, and a message', () => {
    expect(extractErrorBody({ error: { message: 'Resource not found' } })).toBe('Resource not found')
    expect(extractErrorBody({ error: 'authorization_pending' })).toBe('authorization_pending')
    expect(extractErrorBody({ message: 'plain' })).toBe('plain')
    expect(extractErrorBody(undefined)).toBe('')
  })

  it('carries the server\'s error code, which callers decide on', () => {
    expect(new ApiError('409', 409, { error: { message: 'Name taken: a', code: 'name_taken' } }).code).toBe('name_taken')
    expect(new ApiError('400', 400, { error: 'authorization_pending' }).code).toBe('authorization_pending')
    expect(new ApiError('409', 409, { error: { message: 'x', code: null } }).code).toBeNull()
    expect(new ApiError('502', 502, undefined).code).toBeNull()
  })
})

describe('mapApiError', () => {
  it('maps 401 to the auth exit code with the login hint', () => {
    const err = mapApiError(new ApiError('401', 401, {}), CTX)
    expect(err.exitCode).toBe(ExitCode.Auth)
    expect(err.detail).toEqual(['Run: orca auth login'])
  })

  it('maps 403 to the auth exit code and keeps the server reason', () => {
    const err = mapApiError(new ApiError('403', 403, { error: { message: 'This action requires the admin role' } }), CTX)
    expect(err.exitCode).toBe(ExitCode.Auth)
    expect(err.message).toContain('admin role')
  })

  it('maps 404 and 410 to the not-found exit code', () => {
    expect(mapApiError(new ApiError('404', 404, {}), CTX).exitCode).toBe(ExitCode.NotFound)
    const gone = mapApiError(
      new ApiError('410', 410, { error: { message: 'This CLI is too old for Orca. Run orca update.' } }),
      CTX,
    )
    expect(gone.exitCode).toBe(ExitCode.NotFound)
    expect(gone.message).toBe('This CLI is too old for Orca. Run orca update.')
  })

  it('maps openai errors the same way', () => {
    const notFound = OpenAIAPIError.generate(404, { error: { message: 'Resource not found' } }, undefined, new Headers())
    expect(mapApiError(notFound, CTX)).toMatchObject({ exitCode: ExitCode.NotFound, message: 'not found: Resource not found' })
    const quota = OpenAIAPIError.generate(
      429,
      { error: { message: 'Your plan runs 1 sessions at once', code: 'rate_limit_exceeded' } },
      undefined,
      new Headers(),
    )
    expect(mapApiError(quota, CTX).message).toBe('429: Your plan runs 1 sessions at once')
  })

  it('maps an unreachable host to a connectivity error', () => {
    expect(mapApiError(new TypeError('fetch failed'), CTX).message).toContain('cannot reach http://test:8080')
    expect(mapApiError(new APIConnectionError({ message: 'Connection error.' }), CTX).message).toContain('cannot reach')
  })

  it('keeps a 5xx answer\'s message, which the server writes for people, with a retry hint', () => {
    const err = mapApiError(new ApiError('503', 503, { error: { message: 'No sandbox is free right now', code: 'sandbox_capacity' } }), CTX)
    expect(err.message).toContain('returned 503')
    expect(err.message).toContain('No sandbox is free right now')
  })

  it('names the field a refusal is about', () => {
    const err = mapApiError(
      new ApiError('400', 400, { error: { message: 'Expected a boolean', param: 'multi_agent.enabled', code: 'invalid_value' } }),
      CTX,
    )
    expect(err.message).toBe('400: Expected a boolean (multi_agent.enabled)')
  })
})
