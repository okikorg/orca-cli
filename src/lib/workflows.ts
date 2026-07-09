// Workflow surface for the tenant API (docs/openapi.sdk.yaml, tag Workflows).
// Shapes mirror agent-runtime/types/plan.go, which is the wire source of
// truth: status fields are integer enums (no DTO translation in plans.go),
// so we keep them numeric and convert via the label maps below. This module
// owns the workflow types, the definition/run/schedule fetch helpers, node
// ordering for the DAG view, and the snapshot-based run stream. It touches no
// files another agent edits: color/label helpers live here so both the plain
// sinks and the Ink views share one source.

import { ApiClient, ApiError, pageQuery, type Paged, type PageParams } from './api.js'
import { stripControlSequences } from './markdown.js'
import { SSEBuffer } from './sse.js'
import { theme } from '../ui/theme.js'

// -- Status enums -------------------------------------------------------------

// PlanStatus / WorkflowRunStatus: pending=0 running=1 paused=2 completed=3
// failed=4 cancelled=5.
export type WfStatus = 0 | 1 | 2 | 3 | 4 | 5
// NodeStatus: pending=0 ready=1 running=2 ok=3 error=4 skipped=5 cancelled=6.
export type WfNodeStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const WF_STATUS_LABEL: Record<WfStatus, string> = {
  0: 'pending',
  1: 'running',
  2: 'paused',
  3: 'completed',
  4: 'failed',
  5: 'cancelled',
}

export const WF_NODE_STATUS_LABEL: Record<WfNodeStatus, string> = {
  0: 'pending',
  1: 'ready',
  2: 'running',
  3: 'ok',
  4: 'error',
  5: 'skipped',
  6: 'cancelled',
}

export function wfStatusLabel(s: WfStatus): string {
  return WF_STATUS_LABEL[s] ?? `status ${s}`
}

export function wfNodeStatusLabel(s: WfNodeStatus): string {
  return WF_NODE_STATUS_LABEL[s] ?? `status ${s}`
}

// A run is terminal (the engine will emit no further changes) once it has
// completed, failed, or been cancelled.
export function isTerminalStatus(s: WfStatus): boolean {
  return s === 3 || s === 4 || s === 5
}

// wfStatusColor maps a run status to a theme hex, mirroring the dashboard's
// PLAN_BADGE intent: running is coral, failed is destructive, completed keeps
// the default terminal foreground, everything idle is subtle.
export function wfStatusColor(s: WfStatus): string | undefined {
  switch (s) {
    case 1:
      return theme.accent
    case 4:
      return theme.destructive
    case 0:
    case 2:
    case 5:
      return theme.subtle
    case 3:
      return undefined
  }
}

// nodeStatusColor mirrors NODE_BADGE: running coral, error destructive, ok
// default fg, the rest subtle.
export function nodeStatusColor(s: WfNodeStatus): string | undefined {
  switch (s) {
    case 2:
      return theme.accent
    case 4:
      return theme.destructive
    case 3:
      return undefined
    default:
      return theme.subtle
  }
}

// A schedule is operator-controlled, not run-lifecycle: active or paused.
export function scheduleStateColor(state: string): string | undefined {
  if (state === 'active') return theme.accent
  return theme.subtle
}

// -- Wire types ---------------------------------------------------------------

export type WorkflowNode = {
  id: string
  title?: string
  profile: string
  sessionId?: string
  promptTemplate: string
  dependsOn?: string[]
  outputSchema?: unknown
  status: WfNodeStatus
  runId?: string
  output?: string
  fields?: unknown
  error?: string
  attempt: number
  startedAt?: string
  finishedAt?: string
}

// WorkflowRun is the executable instance (Plan on the wire).
export type WorkflowRun = {
  id: string
  userPrompt: string
  orchestratorRunId?: string
  orchestratorSessionId?: string
  status: WfStatus
  autoStart: boolean
  nodes: WorkflowNode[]
  createdAt: string
  startedAt?: string
  finishedAt?: string
  repairCount: number
  deadline?: string
  delegationDepth?: number
}

// WorkflowDefinition is the reusable graph template.
export type WorkflowDefinition = {
  id: string
  name: string
  description?: string
  userPrompt?: string
  nodes: WorkflowNode[]
  defaults?: unknown
  inputSchema?: unknown
  metadata?: unknown
  createdAt: string
  updatedAt: string
}

export type WorkflowSchedule = {
  id: string
  workflowDefinitionId: string
  name?: string
  cron: string
  timezone?: string
  dedupeKeyTemplate?: string
  input?: Record<string, unknown>
  status: 'active' | 'paused'
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  lastError?: string
}

// Accepted-action envelope returned by create/start/cancel/repair.
export type WorkflowRunAction = { workflowRunId: string; status?: string; ok?: boolean }

// PlanCreateRequest body for POST /api/workflows/runs. Inbound node status is
// ignored server-side; the engine drives transitions.
export type CreateWorkflowRunRequest = {
  userPrompt: string
  nodes: WorkflowNode[]
  autoStart?: boolean
  orchestratorRunId?: string
  orchestratorSessionId?: string
}

export type RepairAction = {
  type: 'retry_node' | 'replace_node' | 'add_dependency' | 'abort'
  nodeId?: string
  replacement?: WorkflowNode
  dependsOn?: string[]
}

// -- Fetch helpers ------------------------------------------------------------
// These wrap ApiClient.request so command code stays declarative; the ao_
// tenant key is carried by the client and the server derives the tenant.

const enc = encodeURIComponent

export function listWorkflowDefinitions(
  client: ApiClient,
  params?: PageParams,
): Promise<Paged<WorkflowDefinition>> {
  return client.requestPaged<WorkflowDefinition>(
    `/api/workflows/definitions${pageQuery({ ...params })}`,
  )
}

export function getWorkflowDefinition(client: ApiClient, id: string): Promise<WorkflowDefinition> {
  return client.request<WorkflowDefinition>(`/api/workflows/definitions/${enc(id)}`)
}

export function deleteWorkflowDefinition(client: ApiClient, id: string): Promise<void> {
  return client.request<void>(`/api/workflows/definitions/${enc(id)}`, { method: 'DELETE' })
}

export type ListRunsParams = {
  status?: string
  limit?: number
  offset?: number
  orchestratorRunId?: string
}

export function listWorkflowRuns(
  client: ApiClient,
  params?: ListRunsParams,
): Promise<Paged<WorkflowRun>> {
  const qs = pageQuery({
    status: params?.status,
    limit: params?.limit,
    offset: params?.offset,
    orchestratorRunId: params?.orchestratorRunId,
  })
  return client.requestPaged<WorkflowRun>(`/api/workflows/runs${qs}`)
}

export function getWorkflowRun(client: ApiClient, id: string): Promise<WorkflowRun> {
  return client.request<WorkflowRun>(`/api/workflows/runs/${enc(id)}`)
}

export function createWorkflowRun(
  client: ApiClient,
  body: CreateWorkflowRunRequest,
): Promise<WorkflowRunAction> {
  return client.request<WorkflowRunAction>('/api/workflows/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function startWorkflowRun(client: ApiClient, id: string): Promise<WorkflowRunAction> {
  return client.request<WorkflowRunAction>(`/api/workflows/runs/${enc(id)}/start`, { method: 'POST' })
}

export function cancelWorkflowRun(client: ApiClient, id: string): Promise<WorkflowRunAction> {
  return client.request<WorkflowRunAction>(`/api/workflows/runs/${enc(id)}/cancel`, { method: 'POST' })
}

export function repairWorkflowRun(
  client: ApiClient,
  id: string,
  action: RepairAction,
): Promise<WorkflowRunAction> {
  return client.request<WorkflowRunAction>(`/api/workflows/runs/${enc(id)}/repair`, {
    method: 'POST',
    body: JSON.stringify(action),
  })
}

export function listWorkflowSchedules(
  client: ApiClient,
  params?: PageParams,
): Promise<Paged<WorkflowSchedule>> {
  return client.requestPaged<WorkflowSchedule>(
    `/api/workflows/schedules${pageQuery({ ...params })}`,
  )
}

export function getWorkflowSchedule(client: ApiClient, id: string): Promise<WorkflowSchedule> {
  return client.request<WorkflowSchedule>(`/api/workflows/schedules/${enc(id)}`)
}

export function pauseWorkflowSchedule(client: ApiClient, id: string): Promise<WorkflowSchedule> {
  return client.request<WorkflowSchedule>(`/api/workflows/schedules/${enc(id)}/pause`, { method: 'POST' })
}

export function resumeWorkflowSchedule(client: ApiClient, id: string): Promise<WorkflowSchedule> {
  return client.request<WorkflowSchedule>(`/api/workflows/schedules/${enc(id)}/resume`, { method: 'POST' })
}

export function deleteWorkflowSchedule(client: ApiClient, id: string): Promise<void> {
  return client.request<void>(`/api/workflows/schedules/${enc(id)}`, { method: 'DELETE' })
}

// -- DAG ordering -------------------------------------------------------------

export type OrderedNode = { node: WorkflowNode; depth: number }

// orderNodes returns the nodes in execution order: sorted by dependency depth
// (longest path from a root), preserving the definition's own order within a
// depth. Depth drives the indent in the step tree. Unknown dependency ids and
// cycles are tolerated (treated as depth 0 / broken edges) so a malformed
// graph still renders rather than throwing.
export function orderNodes(nodes: WorkflowNode[]): OrderedNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()

  function compute(id: string): number {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // cycle guard: break the edge at 0
    visiting.add(id)
    const node = byId.get(id)
    const deps = (node?.dependsOn ?? []).filter((d) => byId.has(d))
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(compute))
    visiting.delete(id)
    depth.set(id, value)
    return value
  }

  return nodes
    .map((node, index) => ({ node, depth: compute(node.id), index }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(({ node, depth: d }) => ({ node, depth: d }))
}

// Step titles are user/server-defined free text; strip terminal control bytes
// at the source so every sink (Ink tree, transitions, plain rows) is safe and
// width math matches what actually renders.
export function nodeName(node: WorkflowNode): string {
  const name = node.title && node.title.trim() ? node.title : node.id
  return stripControlSequences(name)
}

// -- Run stream ---------------------------------------------------------------
// GET /api/workflows/runs/{id}/stream is snapshot-based, not incremental: the
// server sends a `snapshot` frame then one `plan_status` frame per state
// change, each carrying a FULL run snapshot as {"type","workflowRun"}, and
// closes once the run is terminal. There is no replay-by-count to skip, so a
// reconnect simply re-reads the latest snapshot (identical snapshots produce
// no new transitions downstream). This differs from the run-event stream in
// lib/sse.ts, which is why it lives here rather than reusing streamRunEvents.

export type WorkflowFrame = { type: string; workflowRun: WorkflowRun }

// decodeWorkflowFrame parses one SSE data payload. It accepts the documented
// {type, workflowRun} envelope and also tolerates a bare run snapshot, so a
// future/renamed key does not silently drop frames.
export function decodeWorkflowFrame(data: string): WorkflowFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>
    if (rec.workflowRun && typeof rec.workflowRun === 'object') {
      return { type: typeof rec.type === 'string' ? rec.type : 'plan_status', workflowRun: rec.workflowRun as WorkflowRun }
    }
    // Bare Plan snapshot fallback.
    if (typeof rec.id === 'string' && typeof rec.status === 'number') {
      return { type: 'snapshot', workflowRun: rec as unknown as WorkflowRun }
    }
  }
  return null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

// streamWorkflowRun tails a run to terminal status, delivering every decoded
// frame to onFrame. It returns the final status, or the last-known status
// ('running' when nothing arrived) if the caller aborts. HTTP-level
// rejections (401/404/...) throw ApiError; a dropped connection falls through
// to a status probe and reconnects with capped backoff.
export async function streamWorkflowRun(
  client: ApiClient,
  runId: string,
  onFrame: (frame: WorkflowFrame) => void,
  opts: { signal: AbortSignal },
): Promise<WfStatus> {
  let attempt = 0
  let lastStatus: WfStatus = 1 // assume running until we learn otherwise

  for (;;) {
    if (opts.signal.aborted) return lastStatus

    try {
      const res = await fetch(client.url(`/api/workflows/runs/${enc(runId)}/stream`), {
        headers: client.headers({ Accept: 'text/event-stream' }),
        signal: opts.signal,
      })
      if (!res.ok) {
        let body: unknown
        try {
          body = await res.json()
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(`${res.status} ${res.statusText}`, res.status, body)
      }
      if (!res.body) throw new Error('stream response had no body')

      const decoder = new TextDecoder('utf-8')
      const sse = new SSEBuffer()
      const deliver = (data: string) => {
        const frame = decodeWorkflowFrame(data)
        if (!frame) return
        lastStatus = frame.workflowRun.status
        onFrame(frame)
      }
      for await (const chunk of res.body) {
        for (const data of sse.push(decoder.decode(chunk as Uint8Array, { stream: true }))) deliver(data)
      }
      for (const data of sse.push(decoder.decode())) deliver(data)
      const tail = sse.flush()
      if (tail !== null) deliver(tail)
    } catch (err) {
      if (opts.signal.aborted) return lastStatus
      // A rejected subscription (bad key, unknown run) is fatal; a dropped
      // connection falls through to the status probe and reconnects.
      if (err instanceof ApiError) throw err
    }

    if (opts.signal.aborted) return lastStatus
    // The server closes the stream when the run is terminal; probe to learn
    // the final status (and to detect terminal after a mid-stream drop).
    const run = await getWorkflowRun(client, runId)
    lastStatus = run.status
    if (isTerminalStatus(run.status)) return run.status

    attempt++
    await sleep(Math.min(1000 * attempt, 5000), opts.signal)
  }
}

// -- Transition diffing -------------------------------------------------------
// Snapshots are full state, so a human log is built by diffing consecutive
// snapshots into per-node status transitions. Shared by the Ink tail and the
// plain sink so both render identical lines.

export type NodeTransition = {
  nodeId: string
  name: string
  from?: WfNodeStatus
  to: WfNodeStatus
}

// diffTransitions mutates `prev` (nodeId -> last status) and returns the
// transitions introduced by `run`. A node seen for the first time only emits
// a line if it has already moved off pending, so a fresh run does not spew a
// line per queued node; a mid-run reattach still surfaces in-flight state.
export function diffTransitions(prev: Map<string, WfNodeStatus>, run: WorkflowRun): NodeTransition[] {
  const out: NodeTransition[] = []
  for (const node of run.nodes ?? []) {
    const before = prev.get(node.id)
    if (before === node.status) continue
    prev.set(node.id, node.status)
    if (before === undefined && node.status === 0) continue // fresh + pending: stay quiet
    out.push({ nodeId: node.id, name: nodeName(node), from: before, to: node.status })
  }
  return out
}

export function formatTransitionText(t: NodeTransition): string {
  const arrow = t.from !== undefined ? `${wfNodeStatusLabel(t.from)} -> ` : ''
  return `${t.name}  ${arrow}${wfNodeStatusLabel(t.to)}`
}
