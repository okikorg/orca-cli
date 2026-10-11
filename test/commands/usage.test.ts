import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as usageCommand from '../../src/commands/usage.js'
import { registerUsage } from '../../src/commands/usage.js'
import { usageChart } from '../../src/lib/usage.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const NOW = 1_783_245_600 // 2026-07-05T10:00:00Z
const END = NOW + 1
const START = END - 30 * 86_400

const SUMMARY = {
  object: 'usage.summary',
  start: START,
  end: END,
  session_id: null,
  cost_micro_usd: 1_250_000,
  meters: [
    { meter: 'model_tokens', unit: 'tokens', quantity: 4200, cost_micro_usd: 1_200_000, buckets: { output: 200 } },
    { meter: 'web_searches', unit: 'searches', quantity: 2, cost_micro_usd: 50_000, buckets: {} },
    { meter: 'compute_seconds', unit: 'seconds', quantity: 0, cost_micro_usd: 0, buckets: {} },
  ],
  series: {
    interval: 'day',
    points: [
      { start: Date.UTC(2026, 6, 4) / 1000, meter: 'model_tokens', quantity: 4200, cost_micro_usd: 0 },
      { start: Date.UTC(2026, 6, 4) / 1000, meter: 'web_searches', quantity: 2, cost_micro_usd: 50_000 },
      { start: Date.UTC(2026, 6, 5) / 1000, meter: 'model_tokens', quantity: 0, cost_micro_usd: 0 },
      { start: Date.UTC(2026, 6, 5) / 1000, meter: 'web_searches', quantity: 0, cost_micro_usd: 0 },
    ],
  },
}

const { run, stdout, stderr } = commandHarness(registerUsage)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usage summary', () => {
  it('asks for the last 30 days and prints the used meters with the server\'s costs', async () => {
    const calls = stubFetch({ [`GET /api/usage?start=${START}&end=${END}`]: jsonResponse(SUMMARY) })
    await run(['usage'])
    expect(calls).toHaveLength(1)
    expect(stdout()).toBe('model_tokens\t4200\ttokens\t$1.20\nweb_searches\t2\tsearches\t$0.05\n')
  })

  it('says so when nothing was used, rather than printing nothing', async () => {
    stubFetch({ [`GET /api/usage?start=${START}&end=${END}`]: jsonResponse({ ...SUMMARY, meters: SUMMARY.meters.map((m) => ({ ...m, quantity: 0, cost_micro_usd: 0 })) }) })
    await run(['usage'])
    expect(stdout()).toBe('')
    expect(stderr()).toContain('No usage in this window.')
  })

  it('groups by agent, each with its tokens and its cost from group_costs, and narrows to a session', async () => {
    // As the server sends it: tokens at cost 0, the money on the call and
    // search rows, and each key's cost across every meter in group_costs.
    const groups = [
      { meter: 'model_tokens', key: 'agent_1', quantity: 4000, cost_micro_usd: 0 },
      { meter: 'model_calls', key: 'agent_1', quantity: 3, cost_micro_usd: 1_241 + 70 },
      { meter: 'web_searches', key: 'agent_1', quantity: 1, cost_micro_usd: 10_550 },
      { meter: 'model_tokens', key: null, quantity: 200, cost_micro_usd: 0 },
      { meter: 'compute_seconds', key: null, quantity: 60, cost_micro_usd: 500 },
      { meter: 'tool_calls', key: 'agent_2', quantity: 1, cost_micro_usd: 0 },
    ]
    const group_costs = [
      { key: 'agent_1', cost_micro_usd: 11_861 },
      { key: null, cost_micro_usd: 500 },
      { key: 'agent_2', cost_micro_usd: 0 },
    ]
    const start = END - 7 * 86_400
    stubFetch({
      [`GET /api/usage?start=${start}&end=${END}&group_by=agent&session=sess_1`]: jsonResponse({ ...SUMMARY, cost_micro_usd: 12_361, groups, group_costs }),
    })
    await run(['usage', '--days', '7', '--group-by', 'agent', '--session', 'sess_1'])
    expect(stdout()).toBe('agent_1\t4000\t$0.01\n(none)\t200\t$0.0005\n')
  })

  it('rejects an unknown --group-by before any request', async () => {
    const calls = stubFetch({})
    await expect(run(['usage', '--group-by', 'pool'])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('passes the summary through untouched with --json', async () => {
    stubFetch({ [`GET /api/usage?start=${START}&end=${END}`]: jsonResponse(SUMMARY) })
    await run(['--json', 'usage', 'summary'])
    expect(JSON.parse(stdout())).toEqual(SUMMARY)
  })
})

describe('usage events', () => {
  const row = (fields: Record<string, unknown>) => ({
    id: 'use_1',
    object: 'usage.event',
    meter: 'model_tokens',
    unit: 'tokens',
    bucket: 'output',
    quantity: 120,
    provider: 'openai',
    model: 'gpt-5',
    session_id: 'sess_1',
    recorded_at: NOW,
    cost_micro_usd: 1200,
    charged_on: null,
    ...fields,
  })

  it('lists raw rows with their cost', async () => {
    stubFetch({ 'GET /api/usage/events?limit=10&meter=model_tokens': jsonResponse(list([row({})])) })
    await run(['usage', 'events', '--meter', 'model_tokens'])
    expect(stdout()).toBe('2026-07-05 10:00\tmodel_tokens\t120\topenai gpt-5 output\t$0.0012\tsess_1\n')
  })

  it('says where a row\'s money is when another row carries it, never $0.00', async () => {
    stubFetch({
      'GET /api/usage/events?limit=10': jsonResponse(
        list([
          row({ id: 'use_2', cost_micro_usd: 0, charged_on: 'call' }),
          row({ id: 'use_3', meter: 'model_calls', bucket: 'complete', quantity: 1, cost_micro_usd: 35 }),
          row({ id: 'use_4', cost_micro_usd: 0, charged_on: 'search' }),
        ]),
      ),
    })
    await run(['usage', 'events'])
    expect(stdout().split('\n').map((line) => line.split('\t')[4])).toEqual(['on its call', '$0.000035', 'on its search', undefined])
  })

  it('asks only for the charged rows with --charged', async () => {
    const calls = stubFetch({
      'GET /api/usage/events?limit=10&charged=true': jsonResponse(list([row({ meter: 'model_calls', cost_micro_usd: 35 })])),
    })
    await run(['usage', 'events', '--charged'])
    expect(calls).toHaveLength(1)
    expect(stdout()).toContain('$0.000035')
  })
})

describe('usageChart', () => {
  it('plots one meter of the server\'s series as sent, captioned with its bucket', () => {
    expect(usageChart(SUMMARY as never, 'model_tokens', 30)).toEqual({
      values: [4200, 0],
      caption: 'Daily (UTC), model_tokens, last 30 days',
      empty: 'No usage in this window.',
    })
  })

  it('labels an hourly series the same way the dashboard does', () => {
    const hour = Date.UTC(2026, 6, 4, 23) / 1000
    const summary = {
      ...SUMMARY,
      series: {
        interval: 'hour',
        points: [
          { start: hour, meter: 'model_tokens', quantity: 100, cost_micro_usd: 0 },
          { start: hour + 3600, meter: 'model_tokens', quantity: 40, cost_micro_usd: 0 },
        ],
      },
    }
    expect(usageChart(summary as never, 'model_tokens', 1)).toEqual({
      values: [100, 40],
      caption: 'Hourly (UTC), model_tokens, last 1 day',
      empty: 'No usage in this window.',
    })
  })

  it('says why there is no chart for a long window or an older server', () => {
    expect(usageChart({ ...SUMMARY, series: null } as never, 'model_tokens', 400)).toEqual({
      values: [],
      empty: 'No chart for a window over 366 days.',
    })
    expect(usageChart({ ...SUMMARY, series: undefined } as never, 'model_tokens', 30)).toEqual({
      values: [],
      empty: 'No chart: this server sends no series.',
    })
  })

  it('no longer fills a daily series of its own', () => {
    expect('dailySeries' in usageCommand).toBe(false)
  })
})
