import { Box, Static, Text, useApp } from 'ink'
import { useEffect, useRef, useState } from 'react'

import {
  diffTransitions,
  nodeName,
  nodeStatusColor,
  orderNodes,
  wfNodeStatusLabel,
  wfStatusColor,
  wfStatusLabel,
  type NodeTransition,
  type WfNodeStatus,
  type WfStatus,
  type WorkflowFrame,
  type WorkflowNode,
} from '../lib/workflows.js'
import { glyphs, theme } from './theme.js'

// PulseSpinner is the coral streaming indicator, cycling glyphs.spinner (a
// pulse ramp on the Unicode tier, ASCII otherwise). Hand-rolled from the theme
// glyph set so the frame stays font-safe; mirrors RunTail.
function PulseSpinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % glyphs.spinner.length), 120)
    return () => clearInterval(t)
  }, [])
  return <Text color={theme.accent}>{glyphs.spinner[i]}</Text>
}

// meta joins subtle trailer segments with the separator glyph, dropping empties
// so the line never shows a dangling separator. Mirrors RunTail.
function meta(...parts: (string | number | false | undefined)[]): string {
  return parts.filter((p) => p !== '' && p !== false && p != null).join(` ${glyphs.separator} `)
}

// StepTree renders a workflow's nodes in execution order as an indented list:
// step names in the default terminal foreground, profiles in coral, and the
// dependency edges (indent + tree connector + `<- after` note) in subtle gray.
// Edge glyphs come from the theme tier (box-drawing on Unicode, ASCII fallback
// otherwise) - never hardcoded here. When showStatus is set (a run, not a
// definition) each row is prefixed with the node's status, colored via
// nodeStatusColor.
const STATUS_COL = 10
const MAX_LABEL = 44

function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length > width ? text.slice(0, Math.max(1, width - 3)) + '...' : text
}

export function StepTree({ nodes, showStatus }: { nodes: WorkflowNode[]; showStatus?: boolean }) {
  const ordered = orderNodes(nodes)
  // A child row is `<indent><treeBranch> <name>`; the connector width tracks
  // the glyph length (1 on Unicode `├`, 2 on the ASCII `|-`) plus its space.
  const connectorText = `${glyphs.treeBranch} `
  const rawWidth = Math.max(
    4,
    ...ordered.map(
      ({ node, depth }) =>
        depth * 2 + (depth > 0 ? connectorText.length : 0) + nodeName(node).length,
    ),
  )
  const labelWidth = Math.min(MAX_LABEL, rawWidth) + 2

  return (
    <Box flexDirection="column">
      {ordered.map(({ node, depth }) => {
        const indent = '  '.repeat(depth)
        const connector = depth > 0 ? connectorText : ''
        const prefixLen = indent.length + connector.length
        const name = truncate(nodeName(node), labelWidth - prefixLen)
        const deps = (node.dependsOn ?? []).filter((d) => d)
        return (
          <Box key={node.id}>
            {showStatus ? (
              <Box width={STATUS_COL}>
                <Text color={nodeStatusColor(node.status)}>{wfNodeStatusLabel(node.status)}</Text>
              </Box>
            ) : null}
            <Box width={labelWidth}>
              <Text color={theme.subtle}>
                {indent}
                {connector}
              </Text>
              <Text bold>{name}</Text>
            </Box>
            <Text color={theme.accent}>{node.profile}</Text>
            {deps.length > 0 ? <Text color={theme.subtle}>{`  <- ${deps.join(', ')}`}</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}

// Log items live in <Static> so they persist in scrollback after the app
// exits; only the streaming footer is dynamic. The summary is itself a Static
// item because Ink clears the dynamic region on unmount. This mirrors
// RunTail.tsx; the only structural difference is that the workflow stream is
// snapshot-based, so items are node status transitions diffed between frames.
type Item =
  | { kind: 'transition'; key: number; transition: NodeTransition }
  | { kind: 'summary'; key: number; status: WfStatus; runId: string; ok: number; total: number; elapsed: number }

// TransitionLine hangs a step off a tree glyph, then shows its status
// transition (`from -> to`) with the destination colored by the node palette.
function TransitionLine({ transition }: { transition: NodeTransition }) {
  return (
    <Text>
      <Text color={theme.subtle}>{glyphs.treeLast} </Text>
      <Text bold>{transition.name}</Text>
      <Text color={theme.subtle}>
        {'  '}
        {transition.from !== undefined ? `${wfNodeStatusLabel(transition.from)} -> ` : ''}
      </Text>
      <Text color={nodeStatusColor(transition.to)}>{wfNodeStatusLabel(transition.to)}</Text>
    </Text>
  )
}

export type WorkflowTailProps = {
  runId: string
  // Starts the stream; resolves with the terminal status (a non-terminal
  // status means the caller aborted). Provided by the command so this
  // component never touches the API client directly.
  subscribe: (onFrame: (frame: WorkflowFrame) => void) => Promise<WfStatus>
  onDone: (status: WfStatus) => void
}

export function WorkflowTail({ runId, subscribe, onDone }: WorkflowTailProps) {
  const { exit } = useApp()
  const [items, setItems] = useState<Item[]>([])
  // `live` is the footer label only (a snapshot may already report terminal);
  // `final` drives the exit and is set once from the resolved stream, so a
  // terminal frame arriving mid-stream never races the summary write.
  const [live, setLive] = useState<WfStatus>(1)
  const [final, setFinal] = useState<WfStatus | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const elapsedRef = useRef(0)
  const prev = useRef<Map<string, WfNodeStatus>>(new Map())
  const done = final !== null

  useEffect(() => {
    let mounted = true
    subscribe((frame) => {
      if (!mounted) return
      const transitions = diffTransitions(prev.current, frame.workflowRun)
      if (transitions.length > 0) {
        setItems((list) => [
          ...list,
          ...transitions.map((transition, i) => ({
            kind: 'transition' as const,
            key: list.length + i,
            transition,
          })),
        ])
      }
      setLive(frame.workflowRun.status)
    })
      .then((status) => {
        if (!mounted) return
        const run = prev.current
        setItems((list) => [
          ...list,
          {
            kind: 'summary',
            key: list.length,
            status,
            runId,
            ok: countStatus(run, 3),
            total: run.size,
            elapsed: elapsedRef.current,
          },
        ])
        setFinal(status)
      })
      .catch((err: unknown) => {
        if (!mounted) return
        exit(err instanceof Error ? err : new Error(String(err)))
      })
    return () => {
      mounted = false
    }
    // subscribe/onDone are stable for the lifetime of the command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Exit only after the summary frame has committed and flushed. A synchronous
  // exit() in the same effect phase can race the final Static write, so defer
  // one tick (matches RunTail).
  useEffect(() => {
    if (final === null) return
    const t = setTimeout(() => {
      onDone(final)
      exit()
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  useEffect(() => {
    if (done) return
    const t = setInterval(() => {
      elapsedRef.current += 1
      setElapsed(elapsedRef.current)
    }, 1000)
    return () => clearInterval(t)
  }, [done])

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) =>
          item.kind === 'transition' ? (
            <Box key={item.key}>
              <TransitionLine transition={item.transition} />
            </Box>
          ) : (
            // Terminal summary: glyph+word colored by the run status palette,
            // the run id / steps / elapsed trailer subtle and separator-joined.
            <Box key={item.key} marginTop={1}>
              <Text color={wfStatusColor(item.status)}>
                {glyphs.statusFilled} {wfStatusLabel(item.status)}
              </Text>
              <Text color={theme.subtle}>
                {' '}
                {meta(
                  item.runId,
                  item.total > 0 ? `${item.ok}/${item.total} steps ok` : false,
                  `${item.elapsed}s`,
                )}
              </Text>
            </Box>
          )
        }
      </Static>
      {done ? null : (
        // Streaming footer: coral pulse spinner + bold live status word +
        // subtle run id / elapsed trailer.
        <Text>
          <PulseSpinner />
          <Text bold> {wfStatusLabel(live)}</Text>
          <Text color={theme.subtle}> {meta(runId, `${elapsed}s`)}</Text>
        </Text>
      )}
    </Box>
  )
}

// countStatus counts entries in the nodeId -> status map at a given status.
function countStatus(map: Map<string, WfNodeStatus>, status: WfNodeStatus): number {
  let n = 0
  for (const v of map.values()) if (v === status) n++
  return n
}
