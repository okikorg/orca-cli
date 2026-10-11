// Usage costs as the server sums them. A call's money is on its model_calls
// row and a search's on its web_searches row; token rows are at cost 0. So
// a model's, a session's or an agent's cost is never one meter's cost: it is
// the server's group_costs entry for that key. Nothing here adds money up.

import { usdMicro } from './money.js'
import type { UsageEvent, UsageSeriesInterval, UsageSummary } from './types.js'

// The chart's label, the dashboard's too: buckets are UTC hours or days, and
// the chart says so once.
export const SERIES_INTERVAL_LABELS: Record<UsageSeriesInterval, string> = {
  hour: 'Hourly (UTC)',
  day: 'Daily (UTC)',
}

// UsageChart is what `orca usage` plots for one meter: the server's series as
// sent (it picks the bucket and returns the empty ones, so nothing is filled
// here), its caption, and what to print when there is nothing to plot.
export type UsageChart = { values: number[]; caption?: string; empty: string }

export function usageChart(summary: UsageSummary, meter: string, days: number): UsageChart {
  const series = summary.series
  if (series === undefined) return { values: [], empty: 'No chart: this server sends no series.' }
  if (series === null) return { values: [], empty: 'No chart for a window over 366 days.' }
  return {
    values: series.points.filter((p) => p.meter === meter).map((p) => p.quantity),
    caption: `${SERIES_INTERVAL_LABELS[series.interval]}, ${meter}, last ${days} ${days === 1 ? 'day' : 'days'}`,
    empty: 'No usage in this window.',
  }
}

// groupCost is a key's cost from group_costs, or undefined when the server
// sent none for it.
export function groupCost(summary: UsageSummary, key: string | null): number | undefined {
  return summary.group_costs?.find((entry) => entry.key === key)?.cost_micro_usd
}

// GroupRow is one key of `orca usage --group-by`: its model tokens and its
// cost across every meter.
export type GroupRow = { key: string | null; tokens: number; cost: number }

// groupRows lists each key with model tokens or a cost, highest cost first,
// then most tokens. Their costs sum to the summary's cost.
export function groupRows(summary: UsageSummary): GroupRow[] {
  const rows = new Map<string | null, GroupRow>()
  const row = (key: string | null): GroupRow => {
    let found = rows.get(key)
    if (!found) {
      found = { key, tokens: 0, cost: 0 }
      rows.set(key, found)
    }
    return found
  }
  for (const g of summary.groups ?? []) {
    if (g.meter === 'model_tokens') row(g.key).tokens += g.quantity
  }
  for (const entry of summary.group_costs ?? []) row(entry.key).cost = entry.cost_micro_usd
  return [...rows.values()]
    .filter((r) => r.tokens > 0 || r.cost > 0)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
}

// eventCost is a usage row's cost cell: its charge by the money display
// rule, or where its money is when another row carries it.
export function eventCost(event: Pick<UsageEvent, 'cost_micro_usd' | 'charged_on'>): string {
  if (event.charged_on === 'call') return 'on its call'
  if (event.charged_on === 'search') return 'on its search'
  return usdMicro(event.cost_micro_usd)
}
