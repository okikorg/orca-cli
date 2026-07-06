// Pure helpers and wire types for the skills command group. No Ink imports so
// this stays unit-testable. docs/openapi.sdk.yaml is the contract for the
// tenant-key /api/skills surface (list/get/delete + profile attach/detach).
// The folder-import endpoints (import-package + commit) live only in the full
// docs/openapi.yaml and are gated to member+ roles; the CLI still drives them.

import { promises as fs } from 'node:fs'
import path from 'node:path'

// SkillResource mirrors dashboard/src/lib/types.ts SkillResource: one file that
// travels alongside SKILL.md (scripts/, references/, assets/).
export type SkillResource = {
  path: string
  size?: number
  description?: string
  contentType?: string
  sha256?: string
  executable?: boolean
}

// Skill mirrors the conductor's types.Skill wire shape. `body` is the SKILL.md
// content; `source` is "user" | "imported" | "platform".
export type Skill = {
  name: string
  description?: string
  body: string
  tags?: string[]
  source?: 'user' | 'imported' | 'platform'
  resources?: SkillResource[]
  license?: string
  compatibility?: string
  allowedTools?: string
  metadata?: Record<string, string>
  requiresSandbox?: boolean
  createdAt?: string
  updatedAt?: string
}

export type SkillValidation = {
  ok: boolean
  errors: string[]
  warnings: string[]
}

// SkillPackagePreview is the dry-run result the conductor returns after
// unpacking + validating an uploaded skill folder. Nothing is registered yet;
// stagingId is the token the caller posts back to commit this exact payload.
export type SkillPackagePreview = {
  skill: {
    name: string
    description?: string
    license?: string
    compatibility?: string
    allowedTools?: string
    metadata?: Record<string, string>
    body: string
  }
  resources: SkillResource[]
  validation: SkillValidation
  requiresSandbox: boolean
  totalBytes: number
  stagingId: string
}

export type CollectedFile = { relPath: string; bytes: Uint8Array }

// collectSkillPackageFiles walks dir recursively and returns every file with a
// POSIX path relative to dir. Uploading paths relative to the skill directory
// (SKILL.md at the upload root) makes the conductor treat rootDir as "." and
// skip the folder-name-must-match-skill-name check, so `orca skills import`
// works regardless of the directory's basename.
export async function collectSkillPackageFiles(dir: string): Promise<CollectedFile[]> {
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

// encodeResourcePath percent-encodes each path segment but keeps the slashes so
// the conductor's {path...} wildcard sees the separators. Mirrors the
// dashboard's getSkillResource encoding.
export function encodeResourcePath(p: string): string {
  return p
    .split('/')
    .filter((seg) => seg !== '')
    .map(encodeURIComponent)
    .join('/')
}
