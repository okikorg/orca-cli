export type StoragePathEntry = {
  key: string
  size: number
  lastModified: string
}

export type StorageChild = {
  kind: 'directory' | 'file'
  name: string
  key: string
  size: number
  objectCount: number
  lastModified: string
}

export function normalizeStoragePrefix(prefix?: string): string {
  const parts = (prefix ?? '').split('/').filter(Boolean)
  return parts.length ? `${parts.join('/')}/` : ''
}

export function parentStoragePrefix(prefix: string): string {
  const parts = normalizeStoragePrefix(prefix).split('/').filter(Boolean)
  parts.pop()
  return parts.length ? `${parts.join('/')}/` : ''
}

export function projectStorageChildren(entries: StoragePathEntry[], prefix: string): StorageChild[] {
  const normalized = normalizeStoragePrefix(prefix)
  const children = new Map<string, StorageChild>()

  for (const entry of entries) {
    if (!entry.key.startsWith(normalized)) continue
    const rest = entry.key.slice(normalized.length)
    if (!rest) continue
    const slash = rest.indexOf('/')

    if (slash < 0) {
      children.set(entry.key, {
        kind: 'file',
        name: rest,
        key: entry.key,
        size: entry.size,
        objectCount: 1,
        lastModified: entry.lastModified,
      })
      continue
    }

    const name = `${rest.slice(0, slash)}/`
    const key = `${normalized}${name}`
    const current = children.get(key)
    if (current) {
      current.size += entry.size
      current.objectCount += 1
      if (entry.lastModified > current.lastModified) current.lastModified = entry.lastModified
    } else {
      children.set(key, {
        kind: 'directory',
        name,
        key,
        size: entry.size,
        objectCount: 1,
        lastModified: entry.lastModified,
      })
    }
  }

  return [...children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
