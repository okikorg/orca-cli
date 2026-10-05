import type { Command } from 'commander'

import { ApiClient, mapApiError, type Page, type PageParams } from '../lib/api.js'
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
// Every list command shares one pagination shape over the server's cursor
// lists: a --limit (defaulting to 10, uniform across table/plain/json), an
// --after cursor (the last id of the previous page), and an --all escape hatch
// that walks every page. Table/plain views print a hint on stderr naming the
// next cursor when the server has more rows. Keeping this here means the
// flags, defaults, help text, and hint stay identical everywhere.

export const DEFAULT_PAGE_LIMIT = 10

// The server returns at most 100 rows per request; --all pages through in
// windows of this size, up to a hard safety ceiling.
export const FETCH_ALL_PAGE_SIZE = 100
export const FETCH_ALL_MAX_ROWS = 10_000

export type PageFlags = { limit: number; after?: string; all?: boolean }

// addPageFlags attaches the uniform --limit/--after/--all options. Coercion
// is a plain parseInt (validation lives in validatePage, matching the
// codebase's validate-in-the-action convention).
export function addPageFlags(cmd: Command): Command {
  return cmd
    .option('--limit <n>', 'page size (1 to 100)', (v) => parseInt(v, 10), DEFAULT_PAGE_LIMIT)
    .option('--after <id>', 'start after this id (the cursor the previous page printed)')
    .option('--all', 'fetch every page (cannot be combined with --limit/--after)')
}

// validatePage rejects a limit outside the server's 1 to 100 as a usage error
// before the value ever reaches the API. When --all is set it instead rejects
// an explicitly-supplied --limit/--after (they contradict --all). The command
// is consulted so a value left at its default does not count as an explicit
// override.
export function validatePage(opts: { limit?: number; after?: string; all?: boolean }, cmd?: Command): void {
  if (opts.all) {
    const limitFromCli = cmd?.getOptionValueSource('limit') === 'cli'
    if (limitFromCli || opts.after !== undefined) {
      throw new CliError('--all cannot be combined with --limit or --after', ExitCode.Usage)
    }
    return
  }
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 1 || opts.limit > 100)) {
    throw new CliError('--limit must be an integer from 1 to 100', ExitCode.Usage)
  }
}

// fetchAll walks every page of a cursor list, concatenating the rows into one
// array. A hard cap of FETCH_ALL_MAX_ROWS guards against an unbounded loop;
// hitting it prints a stderr warning and returns the truncated set.
export async function fetchAll<T>(fetchPage: (params: PageParams) => Promise<Page<T>>): Promise<Page<T>> {
  const items: T[] = []
  let after: string | undefined
  for (;;) {
    const page = await fetchPage(after ? { limit: FETCH_ALL_PAGE_SIZE, after } : { limit: FETCH_ALL_PAGE_SIZE })
    items.push(...page.items)
    if (!page.hasMore || !page.lastId) break
    if (items.length >= FETCH_ALL_MAX_ROWS) {
      console.error(
        hintText(`Stopped at the ${FETCH_ALL_MAX_ROWS}-row --all cap; page with --limit/--after instead.`),
      )
      items.length = FETCH_ALL_MAX_ROWS
      return { items, hasMore: true, lastId: null }
    }
    after = page.lastId
  }
  return { items, hasMore: false, lastId: null }
}

// fetchPageOrAll resolves the fetch strategy for a list command: --all walks
// every page, otherwise a single page of opts.limit after opts.after is read.
// The fetchPage closure should already wrap its client call in withApi so both
// paths share the exit-code contract.
export async function fetchPageOrAll<T>(
  opts: PageFlags,
  fetchPage: (params: PageParams) => Promise<Page<T>>,
): Promise<Page<T>> {
  if (opts.all) return fetchAll(fetchPage)
  return fetchPage({ limit: opts.limit ?? DEFAULT_PAGE_LIMIT, ...(opts.after ? { after: opts.after } : {}) })
}

// pagedSubtitle renders the Panel subtitle: "N shown, more available" when the
// server has more, else "N total".
export function pagedSubtitle(page: Page<unknown>): string {
  return page.hasMore ? `${page.items.length} shown, more available` : `${page.items.length} total`
}

// printPageHint writes the next-page hint to stderr (never stdout, so
// json/plain piping stays clean) only when the server holds more rows.
export function printPageHint(page: Page<unknown>): void {
  if (page.hasMore && page.lastId) {
    console.error(hintText(`More rows: add --after ${page.lastId}, or use --all.`))
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
