import OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExitCode } from '../../src/lib/errors.js'
import { findTemplate, findVault } from '../../src/lib/names.js'
import { stubFetch } from '../helpers/fetch-mock.js'
import {
  TEMPLATE_ID,
  VAULT_ID,
  template,
  templateByName,
  templateRoute,
  vault,
  vaultByName,
  vaultRoute,
} from '../helpers/session-events.js'

const client = () => new OpenAI({ apiKey: 'test', baseURL: 'http://test:8080/v1', maxRetries: 0 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a template or vault by id or name', () => {
  it('uses an id as given, with one retrieve and no list', async () => {
    const calls = stubFetch({ ...templateRoute(), ...vaultRoute() })
    expect((await findTemplate(client(), TEMPLATE_ID)).id).toBe(TEMPLATE_ID)
    expect((await findVault(client(), VAULT_ID)).id).toBe(VAULT_ID)
    expect(calls.map((c) => c.path)).toEqual([`/v1/agents/environments/templates/${TEMPLATE_ID}`, `/v1/vaults/${VAULT_ID}`])
  })

  it('finds the one with that name', async () => {
    stubFetch({
      ...templateByName('seo-helper', [template('envtmpl_other', 'other'), template(), template('envtmpl_unnamed', null)]),
      ...vaultByName('dataforseo', [vault('vault_other', 'other'), vault()]),
    })
    expect((await findTemplate(client(), 'seo-helper')).id).toBe(TEMPLATE_ID)
    expect((await findVault(client(), 'dataforseo')).id).toBe(VAULT_ID)
  })

  it('says where to look when no name matches', async () => {
    stubFetch({ ...templateByName('seo-helper', [template('envtmpl_other', 'other')]), ...vaultByName('dataforseo', []) })
    await expect(findTemplate(client(), 'seo-helper')).rejects.toMatchObject({
      message: 'no environment template named "seo-helper"',
      exitCode: ExitCode.NotFound,
    })
    await expect(findVault(client(), 'dataforseo')).rejects.toMatchObject({
      message: 'no vault named "dataforseo"',
      exitCode: ExitCode.NotFound,
      detail: ['List vaults with: orca vaults list'],
    })
  })

  it('refuses a name two share, listing both ids', async () => {
    stubFetch({
      ...templateByName('seo-helper', [template('envtmpl_1', 'seo-helper'), template('envtmpl_2', 'seo-helper')]),
      ...vaultByName('dataforseo', [vault('vault_1', 'dataforseo'), vault('vault_2', 'dataforseo')]),
    })
    await expect(findTemplate(client(), 'seo-helper')).rejects.toMatchObject({
      message: '2 environment templates are named "seo-helper"',
      exitCode: ExitCode.Usage,
      detail: ['Pass an id instead: envtmpl_1, envtmpl_2'],
    })
    await expect(findVault(client(), 'dataforseo')).rejects.toMatchObject({
      message: '2 vaults are named "dataforseo"',
      detail: ['Pass an id instead: vault_1, vault_2'],
    })
  })

  it('refuses an empty name before any request', async () => {
    const calls = stubFetch({})
    await expect(findVault(client(), ' ')).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })
})
