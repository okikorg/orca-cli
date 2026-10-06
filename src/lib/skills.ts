// Reading an Agent Skills folder for upload. No Ink imports so this stays
// unit-testable.

import { promises as fs } from 'node:fs'
import path from 'node:path'

export type CollectedFile = { relPath: string; bytes: Buffer }

// collectSkillFiles walks dir recursively and returns every file with a POSIX
// path relative to dir, sorted, so SKILL.md sits at the upload's root.
export async function collectSkillFiles(dir: string): Promise<CollectedFile[]> {
  const out: CollectedFile[] = []
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(childAbs, childRel)
      } else if (entry.isFile()) {
        out.push({ relPath: childRel, bytes: await fs.readFile(childAbs) })
      }
    }
  }
  await walk(dir, '')
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return out
}
