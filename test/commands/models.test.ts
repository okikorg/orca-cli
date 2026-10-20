import { describe, expect, it } from 'vitest'

import { registerModels } from '../../src/commands/models.js'
import { ExitCode } from '../../src/lib/errors.js'
import { priceLine } from '../../src/lib/models.js'
import type { ModelGroups } from '../../src/lib/types.js'
import { commandHarness } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

// A GET /api/models answer: Orca credit with OpenRouter's prices, then the
// organization's own Anthropic key.
const MODELS: ModelGroups = {
  object: 'list',
  openrouter_fee_bps: 550,
  groups: [
    {
      payer: 'orca_credit',
      provider: 'openrouter',
      label: 'Orca credit',
      available: true,
      models: [
        { id: 'orca/openrouter/openai/gpt-5.6-luna', input_micro_usd_per_million: 200_000, output_micro_usd_per_million: 1_200_000 },
        { id: 'orca/openrouter/openrouter/auto', input_micro_usd_per_million: null, output_micro_usd_per_million: null },
      ],
    },
    { payer: 'own_key', provider: 'anthropic', label: 'Anthropic', available: true, models: [{ id: 'anthropic/claude-sonnet-4-5' }] },
  ],
}

const [luna, auto] = MODELS.groups[0].models
const ORCA_ROWS = [
  `${luna.id}\torca\t${priceLine(luna)}\t-\n`,
  `${auto.id}\torca\t${priceLine(auto)}\t-\n`,
]
const ANTHROPIC_ROWS = ['anthropic/claude-sonnet-4-5\tanthropic\t-\t-\n']

// The same answer for a Free organization (free-plan D3.16): the server
// marks each Orca credit model with what Free allows of it.
const FREE = 'orca/openrouter/cohere/north-mini-code:free'
const FABLE = 'orca/openrouter/anthropic/claude-fable-5'
const FREE_MODELS: ModelGroups = {
  ...MODELS,
  groups: [
    {
      ...MODELS.groups[0],
      models: [
        { ...luna, plan: 'within_ceiling' },
        { id: FREE, input_micro_usd_per_million: 0, output_micro_usd_per_million: 0, plan: 'free' },
        { id: FABLE, input_micro_usd_per_million: 10_000_000, output_micro_usd_per_million: 50_000_000, plan: 'pro_and_max' },
      ],
    },
    MODELS.groups[1],
  ],
}

const { run, stdout, stderr } = commandHarness(registerModels)

describe('orca models', () => {
  it('prints one plain row per model: id, who pays, the price and the plan mark', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(MODELS) })
    await run(['models'])
    expect(stdout()).toBe([...ORCA_ROWS, ...ANTHROPIC_ROWS].join(''))
    // The price is the server's, formatted only.
    expect(priceLine(luna)).toMatch(/in, .* out per million tokens$/)
  })

  it('keeps Orca credit with --payer orca', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(MODELS) })
    await run(['models', '--payer', 'orca'])
    expect(stdout()).toBe(ORCA_ROWS.join(''))
  })

  it('keeps one provider\'s key with --payer <provider>', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(MODELS) })
    await run(['models', '--payer', 'anthropic'])
    expect(stdout()).toBe(ANTHROPIC_ROWS.join(''))
  })

  it('refuses a payer the server did not return, naming the ones it did', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(MODELS) })
    await expect(run(['models', '--payer', 'openai'])).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
      detail: ['Payers: orca, anthropic'],
    })
  })

  it('prints the server\'s body with --json', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(MODELS) })
    await run(['--json', 'models'])
    expect(JSON.parse(stdout())).toEqual(MODELS)
  })

  it('prints the server\'s body with only the matching group with --json --payer', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(MODELS) })
    await run(['--json', 'models', '--payer', 'anthropic'])
    expect(JSON.parse(stdout())).toEqual({ ...MODELS, groups: [MODELS.groups[1]] })
  })

  it('names a group the server could not read', async () => {
    const unread: ModelGroups = {
      ...MODELS,
      groups: [...MODELS.groups, { payer: 'own_key', provider: 'openai', label: 'OpenAI', available: false, models: [] }],
    }
    stubFetch({ 'GET /api/models': jsonResponse(unread) })
    await run(['models'])
    expect(stderr()).toContain('OpenAI: the server could not read this list.')
    expect(stdout()).toBe([...ORCA_ROWS, ...ANTHROPIC_ROWS].join(''))
  })

  it('marks the free model and the models that need Pro or Max, as the server says, and nothing else', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(FREE_MODELS) })
    await run(['models', '--payer', 'orca'])
    const [lunaRow, freeRow, fableRow] = stdout().trimEnd().split('\n').map((line) => line.split('\t'))
    expect(lunaRow[0]).toBe(luna.id)
    expect(lunaRow[3]).toBe('-')
    expect(freeRow).toEqual([FREE, 'orca', '$0.00 in, $0.00 out per million tokens', 'free model'])
    expect(fableRow[0]).toBe(FABLE)
    expect(fableRow[3]).toBe('Pro and Max')
  })

  it('passes the plan field through with --json', async () => {
    stubFetch({ 'GET /api/models': jsonResponse(FREE_MODELS) })
    await run(['--json', 'models'])
    expect(JSON.parse(stdout())).toEqual(FREE_MODELS)
  })
})
