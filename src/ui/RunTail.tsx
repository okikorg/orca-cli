import { Box, Static, Text, useApp } from 'ink'
import Spinner from 'ink-spinner'
import { useEffect, useRef, useState } from 'react'

import { addUsage, compactJson, formatUsage } from '../lib/format.js'
import type { RunEvent, RunStatus, Usage } from '../lib/types.js'
import { statusColor, theme } from './theme.js'

// Exported so `orca runs get` can render a finished run's transcript with
// the same per-type styling as the live tail.
export function EventLine({ event }: { event: RunEvent }) {
  switch (event.type) {
    case 'assistant':
      return <Text>{event.message ?? ''}</Text>
    case 'tool_call':
      return (
        <Text color={theme.subtle}>
          tool <Text color={theme.muted}>{event.toolName ?? '?'}</Text> {compactJson(event.input)}
        </Text>
      )
    case 'tool_result':
      return (
        <Text color={event.isError ? theme.destructive : theme.subtle}>
          {'  -> '}
          {compactJson(event.output ?? event.message)}
        </Text>
      )
    case 'progress':
      return event.message ? <Text color={theme.muted}>{event.message}</Text> : null
    case 'error':
      return <Text color={theme.destructive}>error: {event.message ?? 'unknown'}</Text>
    case 'result':
      return event.message ? <Text bold>{event.message}</Text> : null
    case 'usage':
      return null
  }
}

// Log items live in <Static> so they persist in terminal scrollback after
// the app exits; only the streaming footer is dynamic. The terminal summary
// is itself a Static item for the same reason: Ink clears the dynamic
// region on unmount.
type Item =
  | { kind: 'event'; key: number; event: RunEvent }
  | { kind: 'summary'; key: number; status: RunStatus; usage: string; runId: string }

export type RunTailProps = {
  runId: string
  // Starts the stream; resolves with the terminal status ('running' means
  // the stream was aborted). Provided by the command so this component
  // never touches the API client directly.
  subscribe: (onEvent: (event: RunEvent) => void) => Promise<RunStatus>
  onDone: (status: RunStatus) => void
}

export function RunTail({ runId, subscribe, onDone }: RunTailProps) {
  const { exit } = useApp()
  const [items, setItems] = useState<Item[]>([])
  const [status, setStatus] = useState<RunStatus>('running')
  const [elapsed, setElapsed] = useState(0)
  const usage = useRef<Usage>({})
  const [usageText, setUsageText] = useState('')
  const done = status !== 'running'

  useEffect(() => {
    let mounted = true
    subscribe((event) => {
      if (!mounted) return
      if (event.type === 'usage') {
        usage.current = addUsage(usage.current, event.usage)
        setUsageText(formatUsage(usage.current))
        return
      }
      setItems((prev) => [...prev, { kind: 'event', key: prev.length, event }])
    })
      .then((final) => {
        if (!mounted) return
        setItems((prev) => [
          ...prev,
          { kind: 'summary', key: prev.length, status: final, usage: formatUsage(usage.current), runId },
        ])
        setStatus(final)
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

  // Exit only after the summary frame has committed and flushed. Ink writes
  // static output on commit but a synchronous exit() in the same effect
  // phase can still race the final frame, so defer one tick.
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => {
      onDone(status)
      exit()
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  useEffect(() => {
    if (done) return
    const t = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [done])

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) =>
          item.kind === 'event' ? (
            <Box key={item.key}>
              <EventLine event={item.event} />
            </Box>
          ) : (
            <Box key={item.key} marginTop={1}>
              <Text color={statusColor(item.status)}>
                {item.status} <Text color={theme.subtle}>{item.runId}</Text>
                {item.usage ? <Text color={theme.subtle}> {item.usage}</Text> : null}
              </Text>
            </Box>
          )
        }
      </Static>
      {done ? null : (
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.muted}> streaming </Text>
          <Text color={theme.subtle}>
            {runId} {elapsed}s{usageText ? ` ${usageText}` : ''}
          </Text>
        </Text>
      )}
    </Box>
  )
}
