import { Box, Static, Text, useApp } from 'ink'
import { useEffect, useRef, useState } from 'react'

import { addUsage, compactJson, formatUsage } from '../lib/format.js'
import { stripControlSequences } from '../lib/markdown.js'
import type { RunEvent, RunStatus, Usage } from '../lib/types.js'
import { glyphs, statusColor, theme } from './theme.js'

// PulseSpinner is the coral streaming indicator: it cycles glyphs.spinner (a
// pulse ramp on the Unicode tier, an ASCII spinner otherwise) on a fixed
// interval. Hand-rolled from the theme glyph set so the frame always comes
// from a font-safe tier; ink-spinner's default frames are outside it.
function PulseSpinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % glyphs.spinner.length), 120)
    return () => clearInterval(t)
  }, [])
  return <Text color={theme.accent}>{glyphs.spinner[i]}</Text>
}

// meta joins the subtle run-id/elapsed/usage trailer with the separator glyph
// (`·` on the Unicode tier). Empty segments (no usage yet) are dropped so the
// line never shows a dangling separator.
function meta(...parts: (string | number | false | undefined)[]): string {
  return parts.filter((p) => p !== '' && p !== false && p != null).join(` ${glyphs.separator} `)
}

// Exported so `orca runs get` can render a finished run's transcript with
// the same per-type styling as the live tail. Tool calls hang off a tree glyph
// so a transcript reads as a call/result outline. Free-text fields (message,
// tool name) are remote-controlled and stripped of terminal control bytes;
// compactJson output is already control-safe via JSON escaping.
export function EventLine({ event }: { event: RunEvent }) {
  switch (event.type) {
    case 'assistant':
      return <Text>{stripControlSequences(event.message ?? '')}</Text>
    case 'tool_call':
      return (
        <Text>
          <Text color={theme.subtle}>
            {'  '}
            {glyphs.treeLast} tool{' '}
          </Text>
          <Text color={theme.muted}>{stripControlSequences(event.toolName ?? '?')}</Text>{' '}
          {compactJson(event.input)}
        </Text>
      )
    case 'tool_result':
      return (
        <Text color={event.isError ? theme.destructive : theme.subtle}>
          {'    -> '}
          {compactJson(event.output ?? event.message)}
        </Text>
      )
    case 'progress':
      return event.message ? (
        <Text color={theme.muted}>{stripControlSequences(event.message)}</Text>
      ) : null
    case 'error':
      return (
        <Text color={theme.destructive}>
          error: {stripControlSequences(event.message ?? 'unknown')}
        </Text>
      )
    case 'result':
      return event.message ? <Text bold>{stripControlSequences(event.message)}</Text> : null
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
  | { kind: 'summary'; key: number; status: RunStatus; usage: string; runId: string; elapsed: number }

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
  const elapsedRef = useRef(0)
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
          {
            kind: 'summary',
            key: prev.length,
            status: final,
            usage: formatUsage(usage.current),
            runId,
            elapsed: elapsedRef.current,
          },
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
          item.kind === 'event' ? (
            <Box key={item.key}>
              <EventLine event={item.event} />
            </Box>
          ) : (
            // Terminal summary: glyph+word colored by the status palette, the
            // run id / elapsed / usage trailer subtle and separator-joined.
            <Box key={item.key} marginTop={1}>
              <Text color={statusColor(item.status)}>
                {glyphs.statusFilled} {item.status}
              </Text>
              <Text color={theme.subtle}>
                {' '}
                {meta(item.runId, `${item.elapsed}s`, item.usage)}
              </Text>
            </Box>
          )
        }
      </Static>
      {done ? null : (
        // Streaming footer: coral pulse spinner + bold context word + subtle
        // run id / elapsed / usage trailer.
        <Text>
          <PulseSpinner />
          <Text bold> streaming</Text>
          <Text color={theme.subtle}> {meta(runId, `${elapsed}s`, usageText)}</Text>
        </Text>
      )}
    </Box>
  )
}
