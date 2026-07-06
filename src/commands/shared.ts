import type { Command } from 'commander'

import { ApiClient, mapApiError, type Paged, type PageParams } from '../lib/api.js'
import {
  requireApiKey,
  requireApiUrl,
  resolveContext,
  type GlobalFlags,
  type ResolvedContext,
} from '../lib/config.js'
import { CliError, ExitCode } from '../lib/errors.js'
import { hintText } from '../ui/theme.js'

export function globalFlags(cmd: Command): GlobalFlags {
  const opts = cmd.optsWithGlobals()
  return { context: opts.context, apiUrl: opts.apiUrl, json: opts.json }
}

// -- Pagination -----------------------------------------------------------
// Every list command shares one pagination shape: a --limit (defaulting to
// 50, uniform across table/plain/json), a --offset (both forwarded to the
// server), and an --all escape hatch that walks every page. Table/plain views
// also print a "Showing X of Y" hint on stderr once the server has more rows
// than the page returned. Keeping this here means the flags, defaults, help
// text, and hint stay identical everywhere.

export const DEFAULT_PAGE_LIMIT = 10

// The server caps any single list request at 200 rows; --all pages through in
// windows of this size, up to a hard safety ceiling.
export const FETCH_ALL_PAGE_SIZE = 200
export const FETCH_ALL_MAX_ROWS = 10_000

export type PageFlags = { limit: number; offset?: number; all?: boolean }

// addPageFlags attaches the uniform --limit/--offset/--all options. Coercion
// is a plain parseInt (validation lives in validatePage, matching the
// codebase's validate-in-the-action convention). Pass a different default
// (e.g. 200) for a join that must see the full set rather than a user-facing
// page.
export function addPageFlags(cmd: Command, defaultLimit: number = DEFAULT_PAGE_LIMIT): Command {
  return cmd
    .option('--limit <n>', 'page size', (v) => parseInt(v, 10), defaultLimit)
    .option('--offset <n>', 'page offset', (v) => parseInt(v, 10))
    .option('--all', 'fetch every page (cannot be combined with --limit/--offset)')
}

// validatePage rejects a non-positive limit or negative offset as a usage
// error before the value ever reaches the API. When --all is set it instead
// rejects an explicitly-supplied --limit/--offset (they contradict --all); the
// bounds checks are skipped because --all supplies its own page window. The
// command is consulted so a value left at its default does not count as an
// explicit override.
export function validatePage(
  opts: { limit?: number; offset?: number; all?: boolean },
  cmd?: Command,
): void {
  if (opts.all) {
    const limitFromCli = cmd?.getOptionValueSource('limit') === 'cli'
    const offsetFromCli = cmd?.getOptionValueSource('offset') === 'cli'
    if (limitFromCli || offsetFromCli) {
      throw new CliError('--all cannot be combined with --limit or --offset', ExitCode.Usage)
    }
    return
  }
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    throw new CliError('--limit must be a positive integer', ExitCode.Usage)
  }
  if (opts.offset != null && (!Number.isFinite(opts.offset) || opts.offset < 0)) {
    throw new CliError('--offset must be a non-negative integer', ExitCode.Usage)
  }
}

// fetchAll walks every page of a list endpoint, concatenating the rows into
// one array. It reads FETCH_ALL_PAGE_SIZE rows at a time and stops once a page
// comes back short or the server's reported total is reached. A hard cap of
// FETCH_ALL_MAX_ROWS guards against an unbounded loop; hitting it prints a
// stderr warning and returns the truncated set. The returned total is the
// number of rows actually collected, so callers render an "N total" subtitle
// and never a "Showing X of Y" hint over an already-complete set.
export async function fetchAll<T>(
  fetchPage: (params: PageParams) => Promise<Paged<T>>,
): Promise<Paged<T>> {
  const items: T[] = []
  let offset = 0
  for (;;) {
    // Keep the first request identical to a plain single-page fetch (no
    // offset=0) so a set that fits in one page makes exactly one call.
    const page = await fetchPage(
      offset === 0 ? { limit: FETCH_ALL_PAGE_SIZE } : { limit: FETCH_ALL_PAGE_SIZE, offset },
    )
    items.push(...page.items)
    // A short page (fewer rows than requested) is always the last one.
    if (page.items.length < FETCH_ALL_PAGE_SIZE) break
    offset += FETCH_ALL_PAGE_SIZE
    // The server's own total tells us when the whole set has been walked.
    if (offset >= page.total) break
    // Safety valve: never loop unboundedly. Warn and return what we have.
    if (items.length >= FETCH_ALL_MAX_ROWS) {
      console.error(
        hintText(
          `Stopped at the ${FETCH_ALL_MAX_ROWS}-row --all cap; narrow the set or page with --limit/--offset.`,
        ),
      )
      break
    }
  }
  if (items.length > FETCH_ALL_MAX_ROWS) items.length = FETCH_ALL_MAX_ROWS
  return { items, total: items.length }
}

// fetchPageOrAll resolves the fetch strategy for a list command: --all walks
// every page, otherwise a single page of opts.limit/opts.offset is read. The
// fetchPage closure should already wrap its client call in withApi so both
// paths share the exit-code contract.
export async function fetchPageOrAll<T>(
  opts: PageFlags,
  fetchPage: (params: PageParams) => Promise<Paged<T>>,
): Promise<Paged<T>> {
  if (opts.all) return fetchAll(fetchPage)
  const limit = opts.limit ?? DEFAULT_PAGE_LIMIT
  const offset = opts.offset ?? 0
  const page = await fetchPage({ limit: opts.limit, offset: opts.offset })
  // Servers that predate pagination ignore limit/offset and return the whole
  // set. A page larger than the requested limit can only mean that, so emulate
  // the window client-side; total keeps the full count so the hint still fires.
  if (page.items.length > limit) {
    return {
      items: page.items.slice(offset, offset + limit),
      total: Math.max(page.total, page.items.length),
    }
  }
  return page
}

// pagedSubtitle renders the Panel subtitle: "X of Y" when the server has more,
// else "N total".
export function pagedSubtitle(shown: number, total: number): string {
  return total > shown ? `${shown} of ${total}` : `${shown} total`
}

// printPageHint writes the "Showing X of Y" hint to stderr (never stdout, so
// json/plain piping stays clean) only when the server holds more rows than the
// page returned.
export function printPageHint(shown: number, total: number): void {
  if (total > shown) {
    console.error(
      hintText(`Showing ${shown} of ${total}. Use --limit/--offset or --all for more.`),
    )
  }
}

export type ApiContext = {
  client: ApiClient
  resolved: ResolvedContext
}

// apiContext resolves config + env + flags into a ready client, failing with
// the auth/usage exit codes when the key or URL is missing.
export async function apiContext(cmd: Command): Promise<ApiContext> {
  const resolved = await resolveContext(globalFlags(cmd))
  const client = new ApiClient({
    apiUrl: requireApiUrl(resolved),
    apiKey: requireApiKey(resolved),
    contextName: resolved.name,
  })
  return { client, resolved }
}

// withApi rethrows API/network failures as CliErrors with the exit-code
// contract applied. Every command wraps its client calls in this.
export async function withApi<T>(api: ApiContext, fn: (client: ApiClient) => Promise<T>): Promise<T> {
  try {
    return await fn(api.client)
  } catch (err) {
    throw mapApiError(err, { contextName: api.resolved.name, apiUrl: api.client.apiUrl })
  }
}
