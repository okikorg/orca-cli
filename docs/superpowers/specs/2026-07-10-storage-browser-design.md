# Orca CLI Interactive Storage Browser — Design

Date: 2026-07-10
Status: approved

## Goal

Make tenant object storage feel like a filesystem in an interactive terminal instead of printing every recursively matched object. Preserve the existing API and all machine-readable contracts.

## Command behavior

### `orca storage ls [prefix]`

- In a TTY, render only the immediate children of the requested prefix.
- Derive folders from slash-separated object keys and show each folder once.
- Show a `TYPE`, `NAME`, `SIZE`, and `MODIFIED` table. Folder size is the sum of returned descendants; modified time is the newest returned descendant.
- Keep the command one-shot and non-interactive.
- Keep `--json` byte-compatible with the current flat `StorageObjectList` response.
- Keep piped output as the current flat, headerless TSV object list.
- Preserve `--limit`; when the server response may be truncated, say so in the TTY hint rather than pretending the derived folder totals are exhaustive.

### `orca storage browse [prefix]`

- Require an interactive stdin and stdout. In non-interactive use, return a usage error pointing to `storage ls`.
- Open at `/` or the supplied prefix, normalized to a trailing slash for folders.
- Fetch objects for the current prefix on entry and after navigation.
- Collapse returned keys into immediate folders and files using the same pure projection as `storage ls`.
- Render a persistent header with the current path, a filter input, a selectable list, and a compact key guide.
- Arrow keys move selection. Typing filters the current directory. Enter opens a folder. Left arrow or Backspace goes to the parent. Escape or `q` exits.
- Enter on a file opens a compact metadata view with its full key, size, modified time, and copyable follow-up commands for `get` and `rm`. Backspace returns to the directory.
- Do not download, preview, upload, or delete objects from inside the browser in this version. Those mutations remain explicit shell commands.

## Architecture

- Add pure storage-path helpers for prefix normalization, parent calculation, and flat-entry-to-immediate-child projection.
- Add an Ink `StorageBrowser` component responsible only for navigation state and rendering.
- Keep API access in `commands/storage.tsx`; inject an async directory loader into the component.
- Reuse the existing theme, glyphs, table vocabulary, and interrupt exit semantics.

## Error handling

- Initial fetch failures propagate through the existing CLI error mapping.
- Navigation fetch failures remain in the browser, show the error beneath the path, and allow retry or parent navigation.
- Empty directories render `No objects here.` and retain parent/exit controls.
- Control sequences in remote keys are stripped before terminal rendering.

## Testing

- Unit-test path normalization, parent navigation, and directory projection.
- Component-test filtering, folder entry, parent navigation, file details, empty state, and exit.
- Command-test the new route, non-TTY rejection, prefix encoding, and preservation of flat JSON/plain `ls` output.
- Verify focused tests, typecheck, lint, and build without starting a server.

## Non-goals

- Backend API changes or server-side delimiter support.
- A local mount, shell, upload manager, content previewer, or in-browser destructive actions.
- Changing object keys or treating derived folders as stored objects.
