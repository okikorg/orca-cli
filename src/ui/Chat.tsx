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

type ToolState = { id: string; name: string; status: ChatToolStatus }

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

function toolColor(status: ChatToolStatus): string {
  return status === 'error' ? theme.destructive : theme.subtle
}

// Tool trace: one line per tool under the reply, the same tree grammar RunTail
// uses (`└ tool <name>` — tree glyph + subtle "tool", muted name). Glyphs come
// from the map so the ASCII tier swaps the branch character.
function ToolRows({ tools }: { tools: ToolState[] }) {
  return (
    <>
      {tools.map((t) => (
        <Text key={t.id || t.name} color={theme.subtle}>
          {`${glyphs.treeLast} tool `}
          <Text color={theme.muted}>{t.name}</Text>
          <Text color={toolColor(t.status)}> {t.status}</Text>
        </Text>
      ))}
    </>
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
      // Header: bold coral agent name, subtle ` · `-separated metadata (adds
      // the conversation id once the first turn returns one). Hint teaches the
      // two keys the REPL binds.
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={theme.accent} bold>
              {item.agent}
            </Text>
            <Text color={theme.subtle}>
              {`${sep}published agent`}
              {item.conversationId ? `${sep}${item.conversationId}` : ''}
            </Text>
          </Text>
          <Text color={theme.subtle}>{`enter send${sep}ctrl-c cancel/exit`}</Text>
        </Box>
      )
    case 'user':
      return (
        <Box>
          <Text color={theme.accent}>{glyphs.pointer} </Text>
          <Text>{item.text}</Text>
        </Box>
      )
    case 'assistant':
      // Committed reply renders through markdown-lite (default foreground; only
      // metadata is muted). Color is gated so NO_COLOR / piped output stays
      // clean — the same axis colorEnabled() governs everywhere.
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.tools.length > 0 ? <ToolRows tools={item.tools} /> : null}
          <Text>
            <Text color={theme.muted}>{agentLabel}</Text>
            {item.cancelled ? <Text color={theme.subtle}> (cancelled)</Text> : null}
          </Text>
          {item.text ? (
            <Text>{renderMarkdown(item.text, { color: colorEnabled() })}</Text>
          ) : (
            <Text color={theme.subtle}>(empty reply)</Text>
          )}
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
            tools.set(event.id, { id: event.id, name: event.name, status: event.status })
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
        <Box flexDirection="column">
          {liveTools.length > 0 ? <ToolRows tools={liveTools} /> : null}
          {liveText === '' ? (
            <Text>
              <PulseSpinner />
              <Text color={theme.muted}> thinking</Text>
            </Text>
          ) : (
            // Live stream stays raw: markdown is applied only on the committed
            // final message, to avoid re-parsing partial syntax every delta.
            <Text>
              <Text color={theme.muted}>{agentLabel} </Text>
              {liveText}
            </Text>
          )}
        </Box>
      ) : (
        <Box>
          <Text color={theme.accent}>{glyphs.pointer} </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            focus={!streaming && !exiting}
            placeholder="message"
          />
        </Box>
      )}
    </Box>
  )
}
