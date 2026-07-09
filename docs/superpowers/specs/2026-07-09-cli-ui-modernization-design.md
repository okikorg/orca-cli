# Orca CLI UI/UX Modernization — Design

Date: 2026-07-09
Status: approved (interactive brainstorm with visual mockups; user validated each decision)

## Goal

Modernize the look and interaction feel of the orca CLI across all surfaces while
preserving every machine contract (`--json`, plain non-TTY output, `NO_COLOR`,
exit codes) and the existing `lib/ -> commands/ -> ui/` architecture.

Non-goals: new commands, API changes, new runtime dependencies, changes to
plain/JSON output shapes.

## Validated decisions

| Decision | Choice |
| --- | --- |
| Visual direction | C — "minimal conversational": borderless, whitespace hierarchy, coral single accent, contextual next-command hints |
| Chat REPL | B — bare inline prompt (no framed composer) |
| Banner | Inline brand mark + one-line brand header (figlet art retired) |
| Brand mark | Derived from landing favicon (2x2 checkerboard, coral diagonal): `▀▄` in coral — two half-blocks drawing the logo diagonal. ASCII fallback: no mark, plain bold ORCA |
| Glyph policy | Unicode default restricted to the CP437/Latin-1 safe tier (user's terminal font shows tofu for exotic glyphs); ASCII fallback when locale is not UTF-8 or `ORCA_ASCII=1` |
| UX scope | Everything: interactive pickers, redesigned help + first-run, modern confirms + empty states |
| Implementation approach | Evolve in place: restyle existing components, add small primitives, no new deps |

## Design grammar (replaces the border-heavy rules in `src/ui/theme.ts` header and README)

- Hierarchy comes from whitespace and weight, not boxes. No panel borders
  anywhere. The border-gray token survives only for tree edges (topology,
  workflow DAG) and chart axes.
- A view starts with a header line: bold coral title, then ` · `-separated
  metadata in subtle gray (`Agents · 3`, `Runs · 20 · last 24h`).
- Content rows are indented two spaces. Blank lines separate groups.
- Coral (`#FE785D`) is the ONLY accent: headers, prompt marker, running/active
  state, primary emphasis. Status palette unchanged: running=accent,
  error=destructive, cancelled/interrupted=subtle, ok=default foreground.
- Every list view ends with a subtle `next:` hint line teaching follow-up
  commands. Every empty state names the command that creates the missing thing.
- No emoji, ever. No rounded/double borders. No background colors.
- Colors: keep the existing palette tokens exactly (accent, accentStrong,
  muted #A8A8A8, subtle #757575, destructive #DC3C3C, border #3D3D3D).

## Glyph system (`src/ui/theme.ts`)

New `glyphs` export chosen once at startup. Unicode tier uses ONLY characters
from the CP437/Latin-1 legacy set (universal font coverage):

| Role | Unicode | ASCII fallback |
| --- | --- | --- |
| prompt/pointer | `»` | `>` |
| status filled | `●` | `*` |
| status open | `○` | `o` |
| tree branch / last / vertical | `├` `└` `│` | `\|-` `` `- `` `\|` |
| separator dot | `·` | `-` |
| brand mark | `▀▄` | (omitted) |
| spinner frames | `░ ▒ ▓ █ ▓ ▒` (pulse) | `- \ \| /` |
| horizontal rule (charts keep their own) | `─` | `-` |

Do NOT use: `▚ ❯ ✖ ✔ ✓ ▲ ◐` braille — these are the tofu offenders.

Detection (`unicodeEnabled()`): `ORCA_ASCII=1` forces ASCII; otherwise
non-Windows checks `LC_ALL`/`LC_CTYPE`/`LANG` for `UTF-8`; Windows checks
`WT_SESSION`/`TERM_PROGRAM`/`ConEmu` heuristics (mirror is-unicode-supported,
~20 lines, hand-rolled, no dependency). Plain/piped mode never emits glyphs or
color (existing `colorEnabled()` gate; glyph selection is orthogonal but plain
TSV output must remain byte-identical to today).

`POINTER` constant is replaced by `glyphs.pointer` (update `AgentPicker`).

## Brand, banner, help (`src/ui/banner.ts`, `src/cli.ts`)

- Banner (bare `orca`, top-level `--help`):
  `▀▄ ORCA  agent platform CLI  v0.2.0`
  rendered as: coral mark, bold coral ORCA, subtle tagline, muted version.
  The long README tagline is retired from the banner.
- `orca -v`: unchanged output contract (version string on stdout); the update
  hint line on stderr stays.
- Custom commander help formatter (configureHelp) for the TOP-LEVEL help only:
  grouped commands with subtle uppercase group labels:
  - CORE: run, chat, agents, runs
  - OBSERVE: stats, usage, sessions, doctor, topology, ping
  - MANAGE: workflows, pools, skills, mcp, secrets, storage, memory, keys, billing
  - SETUP: auth, context, update
  Each command bold, muted one-line description, two-space indent. Footer:
  `GET STARTED` group with `orca auth login` then `orca doctor` in coral.
  (Note: topology/ping/bundles/apps live in platform.tsx; group whatever
  top-level commands commander actually registers.)
- First-run touch: when no config file exists and no `ORCA_API_KEY`, the brand
  line is followed by a subtle `not signed in · run orca auth login` note.
- Subcommand `--help` keeps commander's default structure (no banner), but
  section headers (Usage/Options/Commands) restyled subtle-uppercase via
  configureHelp styles if cheap; otherwise leave stock.

## Surfaces

### List views (Table.tsx)

Keep the `Column<T>` API. Rendering changes:
- No border, no coral headers. Optional subtle UPPERCASE header row, shown only
  when the caller passes `headers: true` (use for runs/keys/sessions/storage
  and other >3-column or ambiguous tables; omit for agents/pools/context).
- Two-space gutters (keep), MAX_COL cap (keep), truncation (keep).
- New optional props: `title` (bold coral) + `meta` (subtle, joined with ` · `)
  rendered as the header line, and `hint` (subtle `next: ...` footer line).
  Commands may alternatively compose Header/Hint primitives; either way every
  TTY list gets title+count and a hint.
- Status-ish cells render glyph+word via a small helper (`statusDot(status)`)
  so lists show `● running` in accent, `● error` destructive, etc.

### Detail views (Panel.tsx -> Section)

`Panel` becomes a borderless `Section`: bold coral header line (title +
subtle ` · ` meta), children indented two spaces, no frame. Keep the exported
names `Panel`/`Field` working (Panel renders the new Section look) so call
sites keep compiling; `Field` keeps its 12-col subtle label but gains the
2-space indent. Multi-section details separate sections with one blank line.

### Doctor (DoctorReport.tsx + commands/doctor.tsx)

- Header: `Doctor · <api host> · N checks`.
- Rows: `[glyph] [word]  [name padded]  [message muted]`; glyph is `●` colored
  by status (pass=accent, warn=muted, fail=destructive) and `○` subtle for
  skip; word is ok/warn/fail/skip in the same color. `fix:` lines subtle,
  indented under the row.
- Footer summary line: `N ok · N warn · N fail` colored per severity, subtle
  separators. Exit codes, `--strict`, `--json` array shape: unchanged.

### Run tail / workflow tail (RunTail.tsx, WorkflowTail.tsx)

- Streaming footer: coral pulse spinner + bold agent/context word + subtle
  `run_id · 12s · 4.1k tok`.
- Tool calls: `  └ tool <name> {compact json}` — tree glyph + "tool" subtle,
  name muted. Tool results keep `->` indented subtle/destructive.
- Terminal summary (Static): `● done|error|cancelled run_id · 31s · 9.8k tok`
  with glyph+word colored by status palette, metadata subtle.
- Workflow tail step transitions use tree glyphs and the same status grammar.

### Chat REPL (Chat.tsx) — bare inline prompt

- Header (intro item): bold coral agent name + subtle ` · published agent`
  (+ ` · conv_<id>` once known). Hint line: subtle
  `enter send · ctrl-c cancel/exit`.
- Prompt: coral `»` + default-foreground input (TextInput placeholder
  `message`).
- Assistant replies render through `lib/markdown.ts` (below). Muted body is
  wrong — assistant text stays default foreground; only metadata is muted.
- Tool trace: same `└ tool` grammar as RunTail, one line per tool, subtle.
- While streaming: coral pulse spinner + muted `thinking` when no tokens yet;
  live text renders as it arrives (markdown applied only on the committed
  final message; live stream stays raw to avoid re-parsing every delta).
- Exit summary: subtle `conversation conv_… · resume: orca chat <agent> --conversation conv_…`.
- Single-shot/piped mode: unchanged (raw text, no color, conv id on stderr).

### Markdown-lite (`src/lib/markdown.ts`, new; no Ink imports)

Pure `(md: string, opts { color: boolean }) => string` supporting: headings
(bold), `**bold**`, `*italic*` (render bold — many terminals lack italics),
`` `inline code` `` (accentStrong), fenced code blocks (2-space indent, muted),
`- ` lists (glyph bullet), `[text](url)` -> `text (url)` with subtle url.
Everything else passes through. Unit-tested in `test/lib/markdown.test.ts`.
Used by Chat committed messages and `runs get` / EventLine assistant text.

### Usage chart / stats / topology

- `chart.ts` internals stay; captions/axis already subtle. Surrounding views
  drop panels for header-line grammar.
- `stats`: header `Stats · last 24h`, kv totals via Field, per-agent table via
  restyled Table with headers, hotspots as subsections.
- `topology`: keep tree, pull edge glyphs from `glyphs`, header line grammar.

## Interaction UX

### Pickers (`src/ui/Picker.tsx`, generalized from AgentPicker)

Generic filterable single-select: type-to-filter, arrow keys, coral `»`
pointer on the active row, subtle match count, esc cancels (exit 2 semantics
identical to today's missing-arg error path), enter selects. AgentPicker
becomes a thin wrapper. Wire pickers ONLY where an interactive TTY is missing
a required arg:
- `orca run` (exists today — restyle), `orca chat` agent arg,
- `orca agents get|delete|publish|unpublish`,
- `orca context use`,
- `orca runs get|tail|cancel` (choose from recent runs; show id, agent,
  status, age in the rows).
Non-TTY behavior everywhere: unchanged usage error, exit 2.

### Confirms (`src/ui/Confirm.tsx`, new)

Shared y/N prompt for destructive ops (delete/revoke/unpublish/cancel/rm):
coral `»` + message + subtle `(y/N)`; y confirms, anything else declines;
Enter=No. Commands currently using ad-hoc stdin prompts switch to it in TTY
mode. `--yes` bypass and non-TTY semantics: byte-identical to today.
Declines print the existing `Aborted.` hint.

### Empty states and hints

Pattern (TTY only, never in plain/JSON):
- Empty: muted `No <things> yet.` + subtle `  create one: orca <cmd>`.
- Hints: subtle `next: orca <follow-up> · orca <follow-up>` as list footer.
Examples: agents list -> `next: orca agents get <name> · orca run <name> "prompt"`;
runs list -> `next: orca runs tail <id> · orca runs get <id>`; keys list ->
`next: orca keys create [name]`. Each command picks 1-2 sensible follow-ups.

### Errors

Keep `orca: <message>` in destructive + subtle detail lines (cli.ts). No
change to exit codes. Auth failures (exit 3) should include a subtle
`run orca auth login` detail line where the command surfaces them.

## Contracts (unchanged, verified by tests)

- `--json`: byte-identical payloads, stdout only, Ink never mounts.
- Non-TTY stdout: plain TSV lines, no color, no glyphs, no headers/hints.
- `NO_COLOR`: no ANSI codes; glyphs may still render (color and glyphs are
  independent axes).
- New env: `ORCA_ASCII=1` forces ASCII glyph tier.
- Exit codes table in README: unchanged.

## Testing

- Update existing component/command tests for new output (banner, doctor,
  Table, Chat, RunTail, WorkflowTail, KeyReveal, all command tests that
  assert rendered frames).
- New tests: `test/lib/markdown.test.ts`, glyph selection (ORCA_ASCII, locale),
  Picker, Confirm, help formatter grouping, first-run note.
- `npm test`, `npm run lint`, `npm run typecheck` all green at the end.
- Plain-mode TSV and `--json` assertions must NOT need changes — if one does,
  that's a contract regression, fix the code not the test.

## Implementation waves (file ownership; agents must not touch files outside their wave-assignment)

1. **Foundation** (serial): theme.ts (glyphs, unicodeEnabled, grammar docs),
   banner.ts (brand line), lib/markdown.ts (new) + markdown/banner/theme tests.
   README design-language paragraph + env table (`ORCA_ASCII`).
2. **Components** (parallel, disjoint):
   A. Table.tsx + Panel.tsx (+ Table test)
   B. DoctorReport.tsx + commands/doctor.tsx + doctor tests
   C. Chat.tsx + PromptInput.tsx + KeyReveal.tsx (+ their tests)
   D. RunTail.tsx + WorkflowTail.tsx (+ their tests)
   E. Picker.tsx (generalize AgentPicker) + Confirm.tsx (+ new tests)
3. **Commands** (parallel, disjoint):
   F. cli.ts help formatter/groups/first-run + auth.tsx, context.tsx,
      update.tsx (+ their tests)
   G. agents.tsx, pools.tsx, skills.tsx, mcp.tsx (+ their tests)
   H. runs.tsx, sessions.tsx, usage.tsx, stats.tsx, platform.tsx, lib/chart.ts
      caption polish (+ their tests)
   I. keys.tsx, secrets.tsx, storage.tsx, memory.tsx, billing.tsx,
      workflows.tsx, chat.tsx command wiring (+ their tests)
4. **Integrate** (serial): full vitest + eslint + tsc, fix cross-cutting
   fallout, README command-doc touch-ups, final visual smoke pass.

## Risks

- Many test snapshots change at once — mitigated by per-wave targeted test runs
  and the integrate wave.
- Glyph rendering on exotic terminals — mitigated by safe-tier default,
  `ORCA_ASCII`, and plain-mode bypass.
- Commander help formatter APIs vary by major version (v15) — implementer must
  read the installed commander's configureHelp types rather than assume.
