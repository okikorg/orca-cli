import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { useEffect, useMemo, useRef, useState } from 'react'

import { stripControlSequences } from '../lib/markdown.js'
import {
  normalizeStoragePrefix,
  parentStoragePrefix,
  projectStorageChildren,
  type StorageChild,
  type StoragePathEntry,
} from '../lib/storage-paths.js'
import { glyphs, theme } from './theme.js'

export type StorageDirectoryLoad = {
  entries: StoragePathEntry[]
  count: number
  truncated: boolean
}

export type StorageBrowserProps = {
  initialPrefix?: string
  load: (prefix: string) => Promise<StorageDirectoryLoad>
  onExit: () => void
}

const VIEW_ROWS = 12

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`
}

function formatModified(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function safe(value: string): string {
  return stripControlSequences(value)
}

export function StorageBrowser({ initialPrefix, load, onExit }: StorageBrowserProps) {
  const { exit } = useApp()
  const [prefix, setPrefix] = useState(() => normalizeStoragePrefix(initialPrefix))
  const [entries, setEntries] = useState<StoragePathEntry[]>([])
  const [count, setCount] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [selectedFile, setSelectedFile] = useState<StorageChild | null>(null)
  const [reload, setReload] = useState(0)
  const requestId = useRef(0)

  useEffect(() => {
    const id = ++requestId.current
    void load(prefix)
      .then((result) => {
        if (id !== requestId.current) return
        setEntries(result.entries)
        setCount(result.count)
        setTruncated(result.truncated)
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return
        setEntries([])
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [load, prefix, reload])

  const children = useMemo(() => projectStorageChildren(entries, prefix), [entries, prefix])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? children.filter((child) => child.name.toLowerCase().includes(needle)) : children
  }, [children, query])
  const active = filtered.length === 0 ? -1 : Math.min(index, filtered.length - 1)
  const windowStart = Math.max(0, Math.min(active - VIEW_ROWS + 1, filtered.length - VIEW_ROWS))
  const visible = filtered.slice(windowStart, windowStart + VIEW_ROWS)

  useInput((input, key) => {
    if (key.escape || (input === 'q' && query === '' && !selectedFile)) {
      onExit()
      exit()
      return
    }
    if (selectedFile) {
      if (key.backspace || key.delete || key.leftArrow) setSelectedFile(null)
      return
    }
    if (error && input === 'r' && query === '') {
      setLoading(true)
      setError('')
      setReload((value) => value + 1)
      return
    }
    if (key.leftArrow || (key.backspace && query === '')) {
      const parent = parentStoragePrefix(prefix)
      if (parent !== prefix) {
        setLoading(true)
        setError('')
        setPrefix(parent)
        setQuery('')
        setIndex(0)
      }
      return
    }
    if (key.upArrow) {
      setIndex((value) => Math.max(0, value - 1))
      return
    }
    if (key.downArrow) {
      setIndex((value) => Math.min(filtered.length - 1, value + 1))
      return
    }
    if (key.return && active >= 0) {
      const child = filtered[active]
      if (child.kind === 'directory') {
        setLoading(true)
        setError('')
        setPrefix(child.key)
        setQuery('')
        setIndex(0)
      } else {
        setSelectedFile(child)
      }
    }
  })

  if (selectedFile) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={theme.accent} bold>File</Text>
          <Text color={theme.subtle}>{` ${glyphs.separator} /${safe(selectedFile.key)}`}</Text>
        </Text>
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text><Text color={theme.subtle}>size      </Text>{formatBytes(selectedFile.size)}</Text>
          <Text><Text color={theme.subtle}>modified  </Text>{formatModified(selectedFile.lastModified)}</Text>
          <Text color={theme.subtle}>{`get: orca storage get ${safe(selectedFile.key)} --output <file>`}</Text>
          <Text color={theme.subtle}>{`rm:  orca storage rm ${safe(selectedFile.key)}`}</Text>
        </Box>
        <Text color={theme.subtle}>backspace/left back · esc exit</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.accent} bold>Storage</Text>
        <Text color={theme.subtle}>{` ${glyphs.separator} /${safe(prefix)}`}</Text>
      </Text>
      <Box>
        <Text color={theme.accent}>{glyphs.pointer} </Text>
        <TextInput
          value={query}
          onChange={(value) => {
            setQuery(value)
            setIndex(0)
          }}
          placeholder="filter"
        />
      </Box>
      {loading ? <Text color={theme.subtle}>loading...</Text> : null}
      {error ? <Text color={theme.destructive}>error: {safe(error)} · r retry</Text> : null}
      {!loading && !error && filtered.length === 0 ? <Text color={theme.subtle}>No objects here.</Text> : null}
      {!loading && !error && filtered.length > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.subtle}>  TYPE  NAME                                      SIZE       MODIFIED          OBJECTS</Text>
          {visible.map((child, visibleIndex) => {
            const absoluteIndex = windowStart + visibleIndex
            const activeRow = absoluteIndex === active
            return (
              <Text key={child.key} color={activeRow ? theme.accent : undefined} bold={activeRow}>
                {activeRow ? `${glyphs.pointer} ` : '  '}
                {child.kind === 'directory' ? 'DIR ' : 'FILE'}  {safe(child.name).padEnd(40).slice(0, 40)}  {formatBytes(child.size).padEnd(9)}  {formatModified(child.lastModified).padEnd(16)}  {child.objectCount}
              </Text>
            )
          })}
        </Box>
      ) : null}
      <Text color={theme.subtle}>
        {`${filtered.length} items${query ? ` of ${children.length}` : ''}${truncated ? ` ${glyphs.separator} partial (${count} returned)` : ''}`}
      </Text>
      <Text color={theme.subtle}>type filter · arrows move · enter open · left parent · esc exit</Text>
    </Box>
  )
}
