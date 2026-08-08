import { Box, Static, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { useEffect, useRef, useState } from 'react'

import type { ChatEvent, ChatToolStatus, ChatTurnResult } from '../lib/gateway.js'
import { renderMarkdown, stripControlSequences } from '../lib/markdown.js'
import { colorEnabled, glyphs, theme } from './theme.js'

// send is injected by the chat command so this component never touches fetch
// or the gateway client directly (mirrors RunTail's `subscribe`), keeping it
// unit-testable under ink-testing-library. It resolves with how the turn
// ended; it does not reject for gateway `error` events (those arrive as a
// { terminated: 'error' } result so the REPL stays alive).
export type SendTurn = (
  message: string,
  handlers: { onEvent: (event: ChatEvent) => void; signal: AbortSignal },
  conversationId: string | undefined,
) => Promise<ChatTurnResult>

export type ChatProps = {
  agentLabel: string
  initialConversationId?: string
  send: SendTurn
  onExit: (conversationId?: string) => void
}

type ToolState = { id: string; name?: string; status: ChatToolStatus }

type Item =
  | { kind: 'intro'; key: number; agent: string; conversationId?: string }
  | { kind: 'user'; key: number; text: string }
  | { kind: 'assistant'; key: number; text: string; tools: ToolState[]; cancelled?: boolean }
  | { kind: 'error'; key: number; message: string }
  | { kind: 'summary'; key: number; agent: string; conversationId?: string }

// Omit over a union is not distributive by default; this keeps each member's
// own fields so pushItem accepts a fully-typed item minus its key.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
type ItemInput = DistributiveOmit<Item, 'key'>

function compactToolName(name: string): string {
  const parts = name.split('__')
  return stripControlSequences(parts.length > 1 ? parts.at(-1) ?? name : name)
}

type ToolGroup = { phase: string; tools: ToolState[] }

// The gateway does not expose model reasoning, so phase labels are derived
// only from real tool names. This adds scan-friendly structure without
// pretending private chain-of-thought is available to the CLI.
function toolPhase(name: string): string {
  const normalized = compactToolName(name).toLowerCase()
  if (/(^|_)(web|browser|fetch|crawl|search|extract)(_|$)/.test(normalized)) return 'Researching'
  if (/(^|_)(test|lint|typecheck|check|verify|build|compile)(_|$)/.test(normalized)) return 'Verifying'
  if (/(^|_)(write|edit|patch|create|delete|remove|move|copy|mkdir|save)(_|$)/.test(normalized)) {
    return 'Changing files'
  }
  if (/(^|_)(read|list|find|inspect|catalog|info|stat|glob)(_|$)/.test(normalized)) return 'Inspecting'
  if (/(^|_)(run|exec|shell|command|python|bash|terminal)(_|$)/.test(normalized)) return 'Running commands'
  return 'Working'
}

function visibleTools(tools: ToolState[]): ToolState[] {
  // A malformed or out-of-order success frame has no useful user-facing
  // detail. Keep failures visible, but never invent a tool named "tool".
  return tools.filter((tool) => tool.name || tool.status === 'error')
}

function groupTools(tools: ToolState[]): ToolGroup[] {
  const groups: ToolGroup[] = []
  for (const tool of visibleTools(tools)) {
    const phase = tool.name ? toolPhase(tool.name) : 'Working'
    const previous = groups.at(-1)
    if (previous?.phase === phase) previous.tools.push(tool)
    else groups.push({ phase, tools: [tool] })
  }
  return groups
}

// A compact worklog inspired by coding-agent terminals: semantic phase
// headings, one real tool per row, and status conveyed by a stable glyph.
// No arguments or outputs are shown because the public gateway deliberately
// excludes them (they may contain secrets).
function ToolActivity({ tools }: { tools: ToolState[] }) {
  const groups = groupTools(tools)
  return (
    <Box flexDirection="column">
      {groups.map((group, groupIndex) => (
        <Box key={`${group.phase}-${groupIndex}`} flexDirection="column" marginTop={groupIndex === 0 ? 0 : 1}>
          <Text color={theme.muted} bold>{group.phase}</Text>
          {group.tools.map((tool) => {
            const running = tool.status === 'running'
            const failed = tool.status === 'error'
            const marker = running ? glyphs.statusOpen : glyphs.statusFilled
            const markerColor = failed ? theme.destructive : running ? theme.accent : theme.subtle
            const name = tool.name ? compactToolName(tool.name) : 'tool'
            return (
              <Text key={tool.id || tool.name || 'tool'}>
                <Text color={markerColor}>{marker}</Text>
                <Text color={running ? undefined : theme.muted}> {name}</Text>
                {failed ? <Text color={theme.destructive}> failed</Text> : null}
              </Text>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

// PulseSpinner cycles glyphs.spinner (the pulse tier: ░▒▓█▓▒, ASCII -\|/) in
// coral. Hand-rolled rather than ink-spinner so every glyph routes through the
// theme map and the ASCII tier is honored; ink-spinner would draw its own dots.
function PulseSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % glyphs.spinner.length), 120)
    return () => clearInterval(t)
  }, [])
  return <Text color={theme.accent}>{glyphs.spinner[frame]}</Text>
}

function TranscriptItem({ item, agentLabel }: { item: Item; agentLabel: string }) {
  const sep = ` ${glyphs.separator} `
  switch (item.kind) {
    case 'intro':
      // Header: name the surface first, then the selected agent and optional
      // resumed conversation. Avoid exposing the publishing implementation in
      // the user-facing title.
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={theme.accent} bold>
              Chat
            </Text>
            <Text color={theme.subtle}>
              {`${sep}${item.agent}`}
              {item.conversationId ? `${sep}${item.conversationId}` : ''}
            </Text>
          </Text>
          <Text color={theme.subtle}>{`enter send${sep}ctrl-c stop or exit`}</Text>
        </Box>
      )
    case 'user':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted} bold>you</Text>
          <Box paddingLeft={2}>
            <Text color={theme.accent}>{glyphs.pointer} </Text>
            <Text>{item.text}</Text>
          </Box>
        </Box>
      )
    case 'assistant':
      // Committed reply renders through markdown-lite (default foreground; only
      // metadata is muted). Color is gated so NO_COLOR / piped output stays
      // clean — the same axis colorEnabled() governs everywhere.
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={theme.accent} bold>{agentLabel}</Text>
            {item.cancelled ? <Text color={theme.subtle}> (cancelled)</Text> : null}
          </Text>
          <Box flexDirection="column" paddingLeft={2}>
            {visibleTools(item.tools).length > 0 ? <ToolActivity tools={item.tools} /> : null}
            <Box marginTop={visibleTools(item.tools).length > 0 ? 1 : 0}>
              {item.text ? (
                <Text>{renderMarkdown(item.text, { color: colorEnabled() })}</Text>
              ) : (
                <Text color={theme.subtle}>(empty reply)</Text>
              )}
            </Box>
          </Box>
        </Box>
      )
    case 'error':
      // Gateway error text is remote-controlled; neutralize control bytes.
      return (
        <Box marginTop={1}>
          <Text color={theme.destructive}>error: {stripControlSequences(item.message)}</Text>
        </Box>
      )
    case 'summary':
      // Exit summary: subtle conversation id + a copy-paste resume command.
      return (
        <Box marginTop={1}>
          <Text color={theme.subtle}>
            {item.conversationId
              ? `conversation ${item.conversationId}${sep}resume: orca chat ${item.agent} --conversation ${item.conversationId}`
              : 'no conversation started'}
          </Text>
        </Box>
      )
  }
}

export function Chat({ agentLabel, initialConversationId, send, onExit }: ChatProps) {
  const { exit } = useApp()
  const [items, setItems] = useState<Item[]>([
    { kind: 'intro', key: 0, agent: agentLabel, conversationId: initialConversationId },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [liveText, setLiveText] = useState('')
  const [liveTools, setLiveTools] = useState<ToolState[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [exiting, setExiting] = useState(false)

  // Refs mirror state for the useInput closure (which Ctrl-C reads) and for
  // the deferred-exit effect, avoiding stale reads.
  const keyRef = useRef(1)
  const abortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  const exitingRef = useRef(false)
  const convRef = useRef<string | undefined>(initialConversationId)

  const pushItem = (item: ItemInput) =>
    setItems((prev) => [...prev, { ...item, key: keyRef.current++ } as Item])

  function beginExit() {
    if (exitingRef.current) return
    exitingRef.current = true
    pushItem({ kind: 'summary', agent: agentLabel, conversationId: convRef.current })
    setExiting(true)
  }

  function submit(raw: string) {
    const message = raw.trim()
    setInput('')
    if (!message || streamingRef.current || exitingRef.current) return

    pushItem({ kind: 'user', text: message })
    streamingRef.current = true
    setStreaming(true)
    setLiveText('')
    setLiveTools([])
    setElapsed(0)

    const controller = new AbortController()
    abortRef.current = controller
    const tools = new Map<string, ToolState>()
    let accum = ''

    send(
      message,
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'delta') {
            // accum keeps the raw stream (finishTurn re-renders it through
            // renderMarkdown, which sanitizes); the live frame is displayed
            // as-is, so strip control bytes here. Stripping the whole accum
            // (not the delta) also catches sequences split across deltas.
            accum += event.text
            setLiveText(stripControlSequences(accum))
          } else if (event.type === 'tool') {
            const previous = tools.get(event.id)
            tools.set(event.id, {
              id: event.id,
              name: event.name ?? previous?.name,
              status: event.status,
            })
            setLiveTools([...tools.values()])
          }
        },
      },
      convRef.current,
    )
      .then((result) => {
        finishTurn(result, accum, [...tools.values()])
      })
      .catch((err: unknown) => {
        // send() maps gateway HTTP failures to an error result, so a reject
        // here is unexpected; surface it and keep the REPL alive.
        pushItem({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        endStreaming()
      })
  }

  function endStreaming() {
    abortRef.current = null
    streamingRef.current = false
    setStreaming(false)
    setLiveText('')
    setLiveTools([])
    setElapsed(0)
  }

  function finishTurn(result: ChatTurnResult, accum: string, tools: ToolState[]) {
    if (result.terminated === 'done') {
      pushItem({ kind: 'assistant', text: result.message || accum, tools })
      if (result.conversationId) convRef.current = result.conversationId
    } else if (result.terminated === 'aborted') {
      pushItem({ kind: 'assistant', text: accum, tools, cancelled: true })
    } else if (result.terminated === 'dropped') {
      if (accum) pushItem({ kind: 'assistant', text: accum, tools })
      pushItem({ kind: 'error', message: 'stream closed before a terminal done/error event' })
    } else {
      // terminated === 'error'
      pushItem({ kind: 'error', message: result.message || result.errorCode || 'upstream error' })
    }
    endStreaming()
  }

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (streamingRef.current && abortRef.current) {
        abortRef.current.abort()
        return
      }
      beginExit()
    }
  })

  // Defer exit one tick so the summary <Static> item commits before Ink tears
  // down the dynamic region (same race RunTail guards against).
  useEffect(() => {
    if (!exiting) return
    const t = setTimeout(() => {
      onExit(convRef.current)
      exit()
    }, 0)
    return () => clearTimeout(t)
    // onExit/exit are stable for the command's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exiting])

  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => {
      setElapsed((seconds) => seconds + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [streaming])

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => (
          <Box key={item.key} flexDirection="column">
            <TranscriptItem item={item} agentLabel={agentLabel} />
          </Box>
        )}
      </Static>

      {exiting ? null : streaming ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.accent} bold>{agentLabel}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {visibleTools(liveTools).length > 0 ? <ToolActivity tools={liveTools} /> : null}
            <Box marginTop={visibleTools(liveTools).length > 0 ? 1 : 0} flexDirection="column">
              <Text>
                <PulseSpinner />
                <Text color={theme.muted}>
                  {' '}
                  {liveText === '' ? 'working' : 'responding'} {glyphs.separator} {elapsed}s
                </Text>
              </Text>
              {liveText === '' ? null : (
                // Live stream stays raw: markdown is applied only on the committed
                // final message, to avoid re-parsing partial syntax every delta.
                <Text>{liveText}</Text>
              )}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.accent}>{glyphs.pointer} </Text>
          <Text color={theme.muted}>you </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            focus={!streaming && !exiting}
            placeholder={`message ${agentLabel}`}
          />
        </Box>
      )}
    </Box>
  )
}
