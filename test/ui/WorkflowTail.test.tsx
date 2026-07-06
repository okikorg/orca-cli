import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StepTree, WorkflowTail } from '../../src/ui/WorkflowTail.js'
import type { WfStatus, WorkflowFrame, WorkflowNode } from '../../src/lib/workflows.js'

function node(id: string, status: number, dependsOn: string[] = [], title?: string): WorkflowNode {
  return { id, title, profile: `${id}-agent`, promptTemplate: 'p', dependsOn, status: status as WorkflowNode['status'], attempt: 0 }
}

function frame(status: WfStatus, nodes: WorkflowNode[]): WorkflowFrame {
  return {
    type: 'plan_status',
    workflowRun: { id: 'workflow-1', userPrompt: 'go', status, autoStart: true, nodes, createdAt: '', repairCount: 0 },
  }
}

function subscribeWith(frames: WorkflowFrame[], final: WfStatus) {
  return async (onFrame: (f: WorkflowFrame) => void): Promise<WfStatus> => {
    for (const f of frames) onFrame(f)
    await new Promise((r) => setTimeout(r, 10))
    return final
  }
}

// Ink's first yoga layout can block for hundreds of ms, so poll rather than
// sleep a fixed interval.
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('WorkflowTail', () => {
  it('logs node transitions and a terminal summary', async () => {
    const frames = [
      frame(0, [node('a', 0), node('b', 0, ['a'])]),
      frame(1, [node('a', 2), node('b', 0, ['a'])]),
      frame(3, [node('a', 3), node('b', 3, ['a'])]),
    ]
    let done: WfStatus | null = null
    const { frames: rendered } = render(
      <WorkflowTail
        runId="workflow-1"
        subscribe={subscribeWith(frames, 3)}
        onDone={(s) => {
          done = s
        }}
      />,
    )
    await waitFor(() => done !== null)
    const output = rendered.join('\n')
    // Transitions live in <Static> so they show in the frame stream.
    expect(output).toContain('running')
    expect(output).toContain('ok')
    expect(output).toContain('completed workflow-1')
    expect(output).toContain('2/2 steps ok')
    expect(done).toBe(3)
  })

  it('renders a failed summary', async () => {
    let done: WfStatus | null = null
    const { frames: rendered } = render(
      <WorkflowTail
        runId="workflow-2"
        subscribe={subscribeWith([frame(4, [node('a', 4)])], 4)}
        onDone={(s) => {
          done = s
        }}
      />,
    )
    await waitFor(() => done !== null)
    expect(rendered.join('\n')).toContain('failed workflow-2')
    expect(done).toBe(4)
  })
})

describe('StepTree', () => {
  it('renders step names, coral profiles, and ASCII dependency edges', async () => {
    const nodes = [node('fetch', 0, [], 'Fetch'), node('draft', 0, ['fetch'], 'Draft')]
    const { frames } = render(<StepTree nodes={nodes} />)
    await waitFor(() => frames.join('').includes('Draft'))
    const out = frames.join('\n')
    expect(out).toContain('Fetch')
    expect(out).toContain('fetch-agent')
    expect(out).toContain('|-') // indented child connector
    expect(out).toContain('<- fetch') // dependency edge
  })
})
