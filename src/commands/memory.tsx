import type { Command } from 'commander'

import { CliError, ExitCode } from '../lib/errors.js'
import { formatTimestamp } from '../lib/format.js'
import {
  interactive,
  outputMode,
  printJson,
  printPlainRows,
  renderStatic,
} from '../lib/output.js'
import { accentVerb, hintText } from '../ui/theme.js'
import { confirm } from './prompts.js'
import { apiContext, globalFlags, withApi } from './shared.js'

// -- Wire shapes (agent memories + the cross-profile memory bank) -------------
// Anchored on the conductor Memory handlers (agent-runtime/runtime/httpapi/
// memory.go; types/memory.go) and docs/openapi.sdk.yaml (Memory group). The
// tenant is derived from the bearer key. Memories are agent-written (or created
// via the dashboard's LLM-extraction form), so the CLI ships read/search/delete
// only, no create/update.

type AgentMemory = {
  id: string
  profileName: string
  rawInput: string
  processedContent: string
  summary: string
  category: string // preference | fact | behavior | context | general
  source: string // explicit | inferred
  confidence: number
  createdAt: string
  lastAccessedAt: string
  accessCount: number
  stalenessScore: number
  isActive: boolean
  version: number
}

type MemoryListResponse = {
  profile?: string
  total: number
  limit?: number
  offset?: number
  memories: AgentMemory[]
}

type MemoryRelevance = { score: number; recency: number; usage: number; topic: number }
type ScoredMemory = { memory: AgentMemory; relevance: MemoryRelevance }
type MemorySearchResponse = {
  profile: string
  query: string
  count: number
  results: ScoredMemory[]
}

// GET /api/memory-bank without ?limit= returns the grouped snapshot.
type MemoryBankSnapshot = {
  total: number
  profilesWithMemory: number
  memories: Record<string, AgentMemory[]>
}

type MemoryBankStats = {
  totalMemories: number
  profilesWithMemory: number
  perProfile: Record<string, number>
}

type MemoryDeleteResult = { id: string; deleted: boolean }

function fmtConfidence(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '-'
}

function fmtScore(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : '-'
}

// renderMemoryDetail shows one memory as a coral-titled panel of fields plus
// the summary, processed content, and raw input blocks.
async function renderMemoryDetail(agent: string, m: AgentMemory): Promise<void> {
  const { Panel, Field } = await import('../ui/Panel.js')
  const { Box, Text } = await import('ink')
  const { theme } = await import('../ui/theme.js')
  const block = (label: string, value: string) => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.subtle}>{label}</Text>
      <Text color={theme.muted}>{value}</Text>
    </Box>
  )
  await renderStatic(
    <Panel title={m.id} subtitle={agent}>
      <Field label="category" value={m.category} />
      <Field label="source" value={m.source} />
      <Field label="confidence" value={fmtConfidence(m.confidence)} />
      <Field label="staleness" value={fmtConfidence(m.stalenessScore)} />
      <Field label="accesses" value={String(m.accessCount)} />
      <Field label="active" value={m.isActive ? 'yes' : 'no'} valueColor={m.isActive ? theme.accent : theme.subtle} />
      <Field label="version" value={String(m.version)} />
      <Field label="created" value={formatTimestamp(m.createdAt)} />
      <Field label="last seen" value={formatTimestamp(m.lastAccessedAt)} />
      {m.summary ? block('summary', m.summary) : null}
      {m.processedContent ? block('processed', m.processedContent) : null}
      {m.rawInput && m.rawInput !== m.processedContent ? block('raw input', m.rawInput) : null}
    </Panel>,
  )
}

export function registerMemory(program: Command): void {
  const memory = program.command('memory').description('inspect agent memories and the memory bank')

  memory
    .command('list <agent>')
    .description("list an agent's memories")
    .option('--limit <n>', 'page size', (v) => parseInt(v, 10))
    .option('--offset <n>', 'page offset', (v) => parseInt(v, 10))
    .action(async (agent: string, opts: { limit?: number; offset?: number }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const sp = new URLSearchParams()
      if (opts.limit != null) sp.set('limit', String(opts.limit))
      if (opts.offset != null) sp.set('offset', String(opts.offset))
      const qs = sp.toString()
      const res = await withApi(api, (c) =>
        c.request<MemoryListResponse>(
          `/api/profiles/${encodeURIComponent(agent)}/memories${qs ? `?${qs}` : ''}`,
        ),
      )
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(res.memories)
        return
      }
      if (res.memories.length === 0) {
        console.error(hintText(`No memories for agent "${agent}".`))
        return
      }
      if (mode === 'plain') {
        printPlainRows(
          res.memories.map((m) => [
            m.id,
            m.category,
            m.source,
            fmtConfidence(m.confidence),
            formatTimestamp(m.createdAt),
            m.summary,
          ]),
        )
        return
      }

      const { Table } = await import('../ui/Table.js')
      const { Panel } = await import('../ui/Panel.js')
      const { theme } = await import('../ui/theme.js')
      const subtitle =
        res.total > res.memories.length
          ? `${res.memories.length} of ${res.total}`
          : `${res.memories.length} total`
      await renderStatic(
        <Panel title="MEMORIES" subtitle={`${agent}  ${subtitle}`}>
          <Table
            columns={[
              { header: 'id', get: (m: AgentMemory) => m.id, color: () => theme.accent, bold: true },
              { header: 'category', get: (m: AgentMemory) => m.category },
              { header: 'source', get: (m: AgentMemory) => m.source },
              { header: 'confidence', get: (m: AgentMemory) => fmtConfidence(m.confidence) },
              { header: 'summary', get: (m: AgentMemory) => m.summary },
              { header: 'created', get: (m: AgentMemory) => formatTimestamp(m.createdAt) },
            ]}
            rows={res.memories}
          />
        </Panel>,
      )
      if (res.total > res.memories.length) {
        console.error(hintText(`Showing ${res.memories.length} of ${res.total}. Use --limit/--offset for more.`))
      }
    })

  memory
    .command('search <agent> <query>')
    .description("search an agent's memories by relevance")
    .option('--limit <n>', 'max results (default 8)', (v) => parseInt(v, 10))
    .option('--min-score <n>', 'minimum relevance score (default 0.05)', (v) => parseFloat(v))
    .action(
      async (
        agent: string,
        query: string,
        opts: { limit?: number; minScore?: number },
        cmd: Command,
      ) => {
        const flags = globalFlags(cmd)
        const api = await apiContext(cmd)
        const sp = new URLSearchParams({ q: query })
        if (opts.limit != null) sp.set('limit', String(opts.limit))
        if (opts.minScore != null) sp.set('minScore', String(opts.minScore))
        const res = await withApi(api, (c) =>
          c.request<MemorySearchResponse>(
            `/api/profiles/${encodeURIComponent(agent)}/memories/search?${sp.toString()}`,
          ),
        )
        const mode = outputMode(flags)

        if (mode === 'json') {
          printJson(res.results)
          return
        }
        if (res.results.length === 0) {
          console.error(hintText(`No memories matched "${query}" for agent "${agent}".`))
          return
        }
        if (mode === 'plain') {
          printPlainRows(
            res.results.map((r) => [
              r.memory.id,
              fmtScore(r.relevance.score),
              r.memory.category,
              r.memory.summary,
            ]),
          )
          return
        }

        const { Table } = await import('../ui/Table.js')
        const { Panel } = await import('../ui/Panel.js')
        const { theme } = await import('../ui/theme.js')
        await renderStatic(
          <Panel title="MEMORY SEARCH" subtitle={`${agent}  ${res.count} result${res.count === 1 ? '' : 's'}`}>
            <Table
              columns={[
                { header: 'id', get: (r: ScoredMemory) => r.memory.id, color: () => theme.accent, bold: true },
                { header: 'score', get: (r: ScoredMemory) => fmtScore(r.relevance.score) },
                { header: 'category', get: (r: ScoredMemory) => r.memory.category },
                { header: 'summary', get: (r: ScoredMemory) => r.memory.summary },
              ]}
              rows={res.results}
            />
          </Panel>,
        )
      },
    )

  memory
    .command('show <agent> <id>')
    .description('show one memory in full')
    .action(async (agent: string, id: string, _opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const m = await withApi(api, (c) =>
        c.request<AgentMemory>(
          `/api/profiles/${encodeURIComponent(agent)}/memories/${encodeURIComponent(id)}`,
        ),
      )
      const mode = outputMode(flags)
      if (mode === 'json') {
        printJson(m)
        return
      }
      if (mode === 'plain') {
        printPlainRows([
          ['id', m.id],
          ['profile', m.profileName],
          ['category', m.category],
          ['source', m.source],
          ['confidence', fmtConfidence(m.confidence)],
          ['staleness', fmtConfidence(m.stalenessScore)],
          ['accessCount', m.accessCount],
          ['isActive', m.isActive ? 'true' : 'false'],
          ['version', m.version],
          ['createdAt', formatTimestamp(m.createdAt)],
          ['lastAccessedAt', formatTimestamp(m.lastAccessedAt)],
          ['summary', m.summary],
          ['processedContent', m.processedContent],
        ])
        return
      }
      await renderMemoryDetail(agent, m)
    })

  memory
    .command('delete <agent> <id>')
    .description('delete a memory')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (agent: string, id: string, opts: { yes?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      if (!opts.yes) {
        if (!interactive()) {
          throw new CliError('refusing to delete without --yes in non-interactive mode', ExitCode.Usage)
        }
        if (!(await confirm(`Delete memory "${id}" from agent "${agent}"?`))) {
          console.error(hintText('Aborted.'))
          return
        }
      }
      const res = await withApi(api, (c) =>
        c.request<MemoryDeleteResult>(
          `/api/profiles/${encodeURIComponent(agent)}/memories/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        ),
      )
      if (outputMode(flags) === 'json') {
        printJson(res ?? { id, deleted: true })
        return
      }
      console.log(`${accentVerb('Deleted')} memory ${id} from agent "${agent}".`)
    })

  const bank = memory.command('bank').description('cross-profile snapshot of the whole memory bank')

  bank.action(async (_opts: Record<string, never>, cmd: Command) => {
    const flags = globalFlags(cmd)
    const api = await apiContext(cmd)
    const snap = await withApi(api, (c) => c.request<MemoryBankSnapshot>('/api/memory-bank'))
    const mode = outputMode(flags)

    if (mode === 'json') {
      printJson(snap)
      return
    }
    // Flatten the grouped map into one list carrying each entry's profile.
    const flat = Object.entries(snap.memories ?? {})
      .flatMap(([profile, list]) => (list ?? []).map((m) => ({ profile, m })))
      .sort((a, b) => (a.profile === b.profile ? b.m.createdAt.localeCompare(a.m.createdAt) : a.profile.localeCompare(b.profile)))

    if (flat.length === 0) {
      console.error(hintText('The memory bank is empty.'))
      return
    }
    if (mode === 'plain') {
      printPlainRows(
        flat.map((e) => [
          e.profile,
          e.m.id,
          e.m.category,
          e.m.summary,
          formatTimestamp(e.m.createdAt),
        ]),
      )
      return
    }

    const { Table } = await import('../ui/Table.js')
    const { Panel } = await import('../ui/Panel.js')
    const { theme } = await import('../ui/theme.js')
    await renderStatic(
      <Panel title="MEMORY BANK" subtitle={`${snap.total} memories in ${snap.profilesWithMemory} profile${snap.profilesWithMemory === 1 ? '' : 's'}`}>
        <Table
          columns={[
            { header: 'profile', get: (e: { profile: string }) => e.profile, color: () => theme.accent, bold: true },
            { header: 'id', get: (e: { m: AgentMemory }) => e.m.id },
            { header: 'category', get: (e: { m: AgentMemory }) => e.m.category },
            { header: 'summary', get: (e: { m: AgentMemory }) => e.m.summary },
            { header: 'created', get: (e: { m: AgentMemory }) => formatTimestamp(e.m.createdAt) },
          ]}
          rows={flat}
        />
      </Panel>,
    )
  })

  bank
    .command('stats')
    .description('bank-wide totals and per-profile counts')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      const api = await apiContext(cmd)
      const stats = await withApi(api, (c) => c.request<MemoryBankStats>('/api/memory-bank/stats'))
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(stats)
        return
      }
      const rows = Object.entries(stats.perProfile ?? {}).sort((a, b) => b[1] - a[1])
      if (mode === 'plain') {
        printPlainRows(rows.map(([profile, count]) => [profile, count]))
        return
      }

      const { Panel, Field } = await import('../ui/Panel.js')
      const { Table } = await import('../ui/Table.js')
      const { Box, Text } = await import('ink')
      const { theme } = await import('../ui/theme.js')
      await renderStatic(
        <Panel title="MEMORY BANK" subtitle="stats">
          <Field label="memories" value={String(stats.totalMemories)} />
          <Field label="profiles" value={String(stats.profilesWithMemory)} />
          {rows.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.subtle}>by profile</Text>
              <Table
                columns={[
                  { header: 'profile', get: (r: [string, number]) => r[0], color: () => theme.accent, bold: true },
                  { header: 'memories', get: (r: [string, number]) => String(r[1]) },
                ]}
                rows={rows}
              />
            </Box>
          ) : null}
        </Panel>,
      )
    })
}
