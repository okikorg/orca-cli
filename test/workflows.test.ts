import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiClient } from '../src/lib/api.js'
import {
  decodeWorkflowFrame,
  diffTransitions,
  formatTransitionText,
  isTerminalStatus,
  nodeName,
  orderNodes,
  streamWorkflowRun,
  wfNodeStatusLabel,
  wfStatusLabel,
  type WfNodeStatus,
  type WfStatus,
  type WorkflowFrame,
  type WorkflowNode,
  type WorkflowRun,
} from '../src/lib/workflows.js'
import { jsonResponse, stubFetch } from './helpers/fetch-mock.js'
import { chunkedBytes, sseFrames, streamResponse } from './helpers/sse-stream.js'

const OPTS = { apiUrl: 'http://test:8080', apiKey: 'ao_dev_k'.padEnd(30, 'x'), contextName: 'test' }

afterEach(() => {
  vi.unstubAllGlobals()
})

function node(id: string, status: WfNodeStatus, dependsOn: string[] = [], title?: string): WorkflowNode {
  return { id, title, profile: `${id}-agent`, promptTemplate: 'p', dependsOn, status, attempt: 0 }
}

function mkRun(status: WorkflowRun['status'], nodes: WorkflowNode[]): WorkflowRun {
  return { id: 'workflow-1', userPrompt: 'go', status, autoStart: true, nodes, createdAt: '2026-07-05T10:00:00Z', repairCount: 0 }
}

describe('status labels + terminal detection', () => {
  it('maps run and node status enums to wire names', () => {
    expect(wfStatusLabel(1)).toBe('running')
    expect(wfStatusLabel(3)).toBe('completed')
    expect(wfNodeStatusLabel(2)).toBe('running')
    expect(wfNodeStatusLabel(3)).toBe('ok')
  })

  it('treats completed/failed/cancelled as terminal only', () => {
    expect(([3, 4, 5] as WfStatus[]).map(isTerminalStatus)).toEqual([true, true, true])
    expect(([0, 1, 2] as WfStatus[]).map(isTerminalStatus)).toEqual([false, false, false])
  })
})

describe('orderNodes', () => {
  it('orders a linear chain by dependency depth', () => {
    const nodes = [node('c', 0, ['b']), node('a', 0, []), node('b', 0, ['a'])]
    const ordered = orderNodes(nodes)
    expect(ordered.map((o) => o.node.id)).toEqual(['a', 'b', 'c'])
    expect(ordered.map((o) => o.depth)).toEqual([0, 1, 2])
  })

  it('keeps definition order within a depth and tolerates a cycle', () => {
    // x <-> y is a cycle; z is a clean root. No throw, everything renders.
    const nodes = [node('x', 0, ['y']), node('y', 0, ['x']), node('z', 0, [])]
    const ordered = orderNodes(nodes)
    expect(ordered.map((o) => o.node.id).sort()).toEqual(['x', 'y', 'z'])
  })

  it('uses the id when a node has no title', () => {
    expect(nodeName(node('n1', 0))).toBe('n1')
    expect(nodeName(node('n1', 0, [], 'Summarize'))).toBe('Summarize')
  })
})

describe('decodeWorkflowFrame', () => {
  it('reads the {type, workflowRun} envelope', () => {
    const run = mkRun(1, [node('a', 2)])
    const frame = decodeWorkflowFrame(JSON.stringify({ type: 'plan_status', workflowRun: run }))
    expect(frame?.type).toBe('plan_status')
    expect(frame?.workflowRun.status).toBe(1)
  })

  it('tolerates a bare run snapshot', () => {
    const run = mkRun(3, [])
    const frame = decodeWorkflowFrame(JSON.stringify(run))
    expect(frame?.type).toBe('snapshot')
    expect(frame?.workflowRun.id).toBe('workflow-1')
  })

  it('returns null for junk', () => {
    expect(decodeWorkflowFrame('not json')).toBeNull()
    expect(decodeWorkflowFrame('{"unrelated":true}')).toBeNull()
  })
})

describe('diffTransitions', () => {
  it('stays quiet for fresh pending nodes, then logs each change', () => {
    const prev = new Map<string, WfNodeStatus>()
    // First snapshot: all pending -> no lines.
    expect(diffTransitions(prev, mkRun(0, [node('a', 0), node('b', 0)]))).toEqual([])
    // a starts running.
    const t1 = diffTransitions(prev, mkRun(1, [node('a', 2), node('b', 0)]))
    expect(t1).toEqual([{ nodeId: 'a', name: 'a', from: 0, to: 2 }])
    // a finishes ok.
    const t2 = diffTransitions(prev, mkRun(1, [node('a', 3), node('b', 0)]))
    expect(t2).toEqual([{ nodeId: 'a', name: 'a', from: 2, to: 3 }])
  })

  it('surfaces already-progressed nodes on first sight (reattach)', () => {
    const prev = new Map<string, WfNodeStatus>()
    const t = diffTransitions(prev, mkRun(1, [node('a', 3), node('b', 2)]))
    expect(t).toEqual([
      { nodeId: 'a', name: 'a', from: undefined, to: 3 },
      { nodeId: 'b', name: 'b', from: undefined, to: 2 },
    ])
  })

  it('formats a transition line with an ASCII arrow', () => {
    expect(formatTransitionText({ nodeId: 'a', name: 'Draft', from: 2, to: 3 })).toBe('Draft  running -> ok')
    expect(formatTransitionText({ nodeId: 'a', name: 'Draft', to: 2 })).toBe('Draft  running')
  })
})

describe('streamWorkflowRun', () => {
  const nodes = [node('a', 0), node('b', 0, ['a'])]

  it('delivers every snapshot across split frames and returns terminal status', async () => {
    const frames: WorkflowFrame[] = [
      { type: 'snapshot', workflowRun: mkRun(0, nodes) },
      { type: 'plan_status', workflowRun: mkRun(1, [node('a', 2), node('b', 0, ['a'])]) },
      { type: 'plan_status', workflowRun: mkRun(3, [node('a', 3), node('b', 3, ['a'])]) },
    ]
    stubFetch({
      // Split at 5-byte boundaries so frames straddle chunks.
      'GET /api/workflows/runs/workflow-1/stream': () => streamResponse(chunkedBytes(sseFrames(frames), [5])),
      'GET /api/workflows/runs/workflow-1': jsonResponse(mkRun(3, [node('a', 3), node('b', 3, ['a'])])),
    })
    const got: WorkflowFrame[] = []
    const status = await streamWorkflowRun(new ApiClient(OPTS), 'workflow-1', (f) => got.push(f), {
      signal: new AbortController().signal,
    })
    expect(status).toBe(3)
    expect(got).toHaveLength(3)
    expect(got.map((f) => f.workflowRun.status)).toEqual([0, 1, 3])
  })

  it('maps a failed run to exit-relevant status 4', async () => {
    stubFetch({
      'GET /api/workflows/runs/workflow-2/stream': () =>
        streamResponse(chunkedBytes(sseFrames([{ type: 'plan_status', workflowRun: mkRun(4, nodes) }]), [1000])),
      'GET /api/workflows/runs/workflow-2': jsonResponse(mkRun(4, nodes)),
    })
    const status = await streamWorkflowRun(new ApiClient(OPTS), 'workflow-2', () => {}, {
      signal: new AbortController().signal,
    })
    expect(status).toBe(4)
  })

  it('throws on an HTTP-level rejection', async () => {
    stubFetch({
      'GET /api/workflows/runs/workflow-3/stream': jsonResponse({ error: 'unknown run' }, { status: 404 }),
    })
    await expect(
      streamWorkflowRun(new ApiClient(OPTS), 'workflow-3', () => {}, {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})
