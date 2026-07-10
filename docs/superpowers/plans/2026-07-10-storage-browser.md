# Interactive Storage Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add directory-level TTY listings and an interactive filesystem-like browser for tenant storage.

**Architecture:** Pure helpers project flat object keys into immediate directory children. `storage ls` uses that projection for its TTY table, while a new Ink `StorageBrowser` receives an injected async loader and owns navigation/filter/detail state. JSON and non-TTY paths keep the existing flat response.

**Tech Stack:** TypeScript 6, Commander 15, React 19, Ink 7, Vitest 4

## Global Constraints

- Do not change the storage HTTP API.
- Do not add runtime dependencies.
- Preserve flat `--json` and piped TSV output for `storage ls`.
- Do not start a server.
- Do not add upload, download, preview, or destructive actions inside the browser.

---

### Task 1: Storage directory projection

**Files:**
- Create: `src/lib/storage-paths.ts`
- Create: `test/lib/storage-paths.test.ts`

**Interfaces:**
- Produces: `normalizeStoragePrefix(prefix?: string): string`
- Produces: `parentStoragePrefix(prefix: string): string`
- Produces: `projectStorageChildren(entries: StoragePathEntry[], prefix: string): StorageChild[]`
- Produces: exported `StoragePathEntry` and `StorageChild` types

- [x] **Step 1: Write failing tests** covering normalization, root parent behavior, immediate files, deduplicated folders, aggregate folder size, newest modification time, and ignoring keys outside the prefix.
- [x] **Step 2: Run `npm test -- test/lib/storage-paths.test.ts`** and verify failure because the module does not exist.
- [x] **Step 3: Implement the pure helpers** using slash-separated key segments. Folder children end in `/`, carry `kind: 'directory'`, descendant byte totals, descendant counts, and newest timestamps.
- [x] **Step 4: Run the focused test** and verify it passes.

### Task 2: Interactive browser component

**Files:**
- Create: `src/ui/StorageBrowser.tsx`
- Create: `test/ui/StorageBrowser.test.tsx`

**Interfaces:**
- Consumes: `normalizeStoragePrefix`, `parentStoragePrefix`, `projectStorageChildren`
- Produces: `StorageBrowser({ initialPrefix, load, onExit })`
- `load(prefix)` resolves `{ entries: StoragePathEntry[]; count: number; truncated: boolean }`

- [x] **Step 1: Write failing component tests** for initial loading, folder entry, left-arrow parent navigation, filtering, file detail selection, empty directories, error/retry state, and escape exit.
- [x] **Step 2: Run `npm test -- test/ui/StorageBrowser.test.tsx`** and verify the missing component failure.
- [x] **Step 3: Implement the component** with an uppercase table header, active coral pointer, at most 12 visible rows, filter input, loading/error messages, current-path header, and key guide. Enter navigates directories or opens file metadata; Backspace/left returns to the parent or directory list; Escape/q exits.
- [x] **Step 4: Run the focused test** and verify it passes.

### Task 3: Command integration and TTY `ls`

**Files:**
- Modify: `src/commands/storage.tsx`
- Modify: `test/commands/storage.test.ts`
- Modify: `README.md`

**Interfaces:**
- Adds command: `orca storage browse [prefix] [--limit N]`
- Reuses: `GET /api/storage/objects?prefix=<prefix>&limit=<limit>`

- [x] **Step 1: Write failing command tests** proving TTY `ls` projects directory children, JSON/plain remain flat, `browse` rejects non-interactive execution, and the browser loader encodes normalized prefixes and limits.
- [x] **Step 2: Run `npm test -- test/commands/storage.test.ts`** and verify the new expectations fail.
- [x] **Step 3: Update `storage ls`** so only its Ink branch projects immediate children and renders `TYPE`, `NAME`, `SIZE`, `MODIFIED`, and `OBJECTS`.
- [x] **Step 4: Register `storage browse`** with interactive-mode validation, normalized prefix loading, `limit` validation from 1 through 1000, and `renderInk(<StorageBrowser ... />)`.
- [x] **Step 5: Document the new behavior and examples in README.**
- [x] **Step 6: Run storage command tests** and verify they pass.

### Task 4: Verification

**Files:**
- Verify all files above and preserve the existing Doctor/Table edits already in the worktree.

- [x] **Step 1: Run focused tests:** `npm test -- test/lib/storage-paths.test.ts test/ui/StorageBrowser.test.tsx test/commands/storage.test.ts test/ui/Table.test.tsx test/commands/doctor.test.tsx`.
- [x] **Step 2: Run `npm run typecheck`.**
- [x] **Step 3: Run `npm run lint`.**
- [x] **Step 4: Run `npm run build`.**
- [x] **Step 5: Run `git diff --check` and review the final diff.**
