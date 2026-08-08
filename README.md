# orca CLI

Manage agents, runs, and publishing on the Orca platform from the terminal.
TypeScript + commander for command routing, Ink (React) for TTY rendering.

Running `orca` with no arguments shows a one-line brand banner and the command
list. In a terminal, list and detail views are borderless: hierarchy comes from
whitespace and weight, not boxes. Each view opens with a bold coral title and
` · `-separated metadata in subtle gray, content rows indent two spaces, and
list views end with a subtle `next:` hint teaching follow-up commands. Coral is
the only accent (`src/ui/theme.ts`); piped or `--json` output stays plain and
machine-clean. Unicode glyphs are restricted to a CP437/Latin-1 safe tier and
fall back to ASCII when the locale is not UTF-8 or `ORCA_ASCII=1` is set.
`NO_COLOR` is honored, independently of the glyph tier.

## Install

End users install a standalone binary (no Node required) via the landing domain:

```sh
curl -fsSL https://orca-landing-woad.vercel.app/install.sh | sh
```

The script detects your OS/arch, downloads the matching binary, verifies its
SHA-256 checksum, and installs to `~/.local/bin/orca`. Pin a version with
`ORCA_VERSION=cli-v0.1.0` or change the target directory with `ORCA_INSTALL_DIR`.
Windows users download `orca-windows-x64.tar.gz` from the
[releases page](https://github.com/okikorg/orca-cli/releases).

This repo is the public home of the CLI source and its release binaries; the
Orca platform it talks to is a separate, private service.

### Updating

`orca update` updates a standalone binary to the latest release in place: it
queries the GitHub Release, downloads the matching `orca-<os>-<arch>` binary,
verifies its SHA-256 against `SHA256SUMS`, and atomically swaps the running
executable.

```sh
orca update                 # update to the latest release
orca update --check         # report whether a newer version exists, don't install
orca update --tag cli-v0.1.0  # install a specific version (also accepts 0.1.0)
orca update --force         # reinstall the target version even if already current
```

`orca -v` prints the version and, in an interactive terminal, appends a hint
when a newer release is available. The check is cached for ~24h under the config
dir (`update-check.json`), is skipped in scripts (non-TTY stderr), and is
disabled entirely by `ORCA_NO_UPDATE_CHECK`. Both commands honor `GITHUB_TOKEN`
to lift the anonymous GitHub API rate limit.

Self-update is only available for the standalone binary. npm installs update via
`npm install -g @agent-orc/cli@latest`; Windows can't replace a running `.exe`,
so re-download `orca-windows-x64.tar.gz` from the releases page. In each of these
cases `orca update` prints the right instructions instead of attempting a swap.

### Releasing binaries

Binaries are Bun-compiled (each embeds the Bun runtime, ~60–100 MB raw / ~23 MB
gzipped) and cross-compiled for all platforms from one CI runner. Cut a release
by pushing a tag; the `release-cli` workflow builds, packages, and publishes the
GitHub Release (default `GITHUB_TOKEN`, no extra secret needed):

```sh
git tag cli-v0.1.0 && git push origin cli-v0.1.0
```

Build locally with `npm run package:binaries` (outputs `dist-bin/*.tar.gz` +
`SHA256SUMS`), or a single target with `npm run build:binary -- bun-linux-x64`.
The `install.sh` served from the landing domain points its `REPO` at this repo.

## Develop / run from source

```sh
git clone https://github.com/okikorg/orca-cli && cd orca-cli
npm install
npm run dev -- --help        # dev loop (tsx)
npm run build && npm link    # global `orca`
```

## Authentication

The CLI authenticates with a tenant API key (`ao_...`). `orca auth login`
opens the dashboard in your browser, you authorize, and the dashboard mints a
role-inheriting key and hands it back to the CLI over a localhost callback.
Keys are stored per context in `~/.config/orca/config.json` (chmod 600).

```sh
orca auth login                              # browser flow; defaults to the Orca production API
orca auth login --api-url http://localhost:8080 --dashboard-url http://localhost:5173
orca auth status
orca auth logout --revoke                    # revoke the key server-side, then clear it
```

`orca auth login` defaults to the Orca production API; pass `--api-url` for a
self-hosted or local conductor. The browser flow needs the dashboard URL: pass
`--dashboard-url` or set `ORCA_DASHBOARD_URL` (until a production default is
baked in). Over SSH, or with `--no-browser`, the dashboard reveals the key once
so you can paste it into the CLI prompt. CI and scripts keep using
`--with-token ao_...` (no browser, no prompt).

Contexts work like kubectl contexts: `orca context list`, `orca context use
prod`, or per-invocation `orca --context prod agents list`.

## Doctor

`orca doctor` is a preflight that verifies everything the other commands need
and prints a concrete fix for every problem it finds. It runs read-only probes
only (it never creates a run, key, or any resource), timeboxes each network
probe to 3s so it never hangs, and completes in a few seconds.

```sh
orca doctor            # Doctor header line, one row per check (status glyph + word), fix lines under failures
orca doctor --json     # array of { name, status, message, fix? }
orca doctor --strict   # promote warnings to failures
```

It checks: Node version (>= 22), the color/TTY situation (informational),
whether the config file exists, parses, and is `chmod 600`, how the active
context resolves (which field came from a flag, env var, file, or baked default),
conductor reachability (`GET /healthz`, with latency), the API key's presence
and validity/role (`GET /api/api-keys`), a billing/credit preflight that predicts
the `POST /api/runs` 402 credit gate without creating a run (reads `GET
/api/billing/wallet` and `GET /api/spend-cap`), the chat gateway URL for `orca
chat`, and the dashboard URL used by `orca auth login`. Each check reports `pass`,
`warn`, `fail`, or `skip`. The exit code is `0` when nothing failed (warnings are
allowed) and `1` when any check failed; `--strict` also fails on warnings.

Environment overrides (all optional, win over the config file):

| Variable          | Meaning                          |
| ----------------- | -------------------------------- |
| `ORCA_API_KEY`    | tenant API key                   |
| `ORCA_API_URL`    | conductor base URL (defaults to the Orca production API) |
| `ORCA_DASHBOARD_URL`| dashboard base URL for `orca auth login` |
| `ORCA_GATEWAY_URL`| public chat gateway base URL     |
| `ORCA_CHAT_KEY`   | published-agent chat key (`orca chat`) |
| `ORCA_TENANT`     | tenant slug for `orca chat`      |
| `ORCA_CONTEXT`    | context name                     |
| `ORCA_CONFIG_DIR` | config directory (default XDG)   |
| `ORCA_ASCII`      | set to `1` to force ASCII glyphs (no Unicode tier) |

CI needs no config file: `ORCA_API_KEY=... ORCA_API_URL=... orca agents list --json`.

## Commands

```
orca auth login [--api-url u] [--dashboard-url u] [--gateway-url u] [--label l] [--no-browser] [--with-token ao_...]
orca auth status
orca auth logout [--revoke]
orca context list|use <name>|show

orca agents list|get <name>
orca agents create -f agent.yaml         # YAML or JSON; - for stdin
orca agents update [name] -f agent.yaml  # target old name to rename
orca agents delete <name> [--yes]
orca agents publish <name> [--slug s] [--visibility v] [--expose-tool-events]
orca agents unpublish <name> [--yes]
orca agents keys list|create [--label l]|revoke <agent> [id]

orca run <agent> "prompt" [--title t] [--session id] [--detach]
orca runs list [--agent name]
orca runs get|tail|cancel <id>

orca keys list|create [name] [--expires <iso8601>]|revoke <id>
```

List commands that page (`agents list`, `runs list`, `keys list`, and the other
`list` views) share `--limit N`, `--offset N`, and `--all` (fetch every page);
see each command's `--help` for its per-command default limit.

Every list/get command supports `--json` (raw API payloads, stdout only).
When stdout is not a TTY, output degrades to uncolored tab-separated lines,
so `orca agents list | cut -f1` works. `runs tail --json` emits one event
per line (ndjson).

Key minting prints the plaintext token exactly once. In a pipe, stdout
carries only the token: `ORCA_API_KEY=$(orca keys create ci </dev/null)`.

Ctrl-C during `orca run` / `orca runs tail` detaches the local stream; the
run keeps going server-side (`orca runs cancel <id>` stops it).

## Chat

`orca chat <agent> [prompt]` talks to a PUBLISHED agent through the public chat
gateway (`/v1/chat`), which is a different surface from the conductor API the
rest of the CLI uses. It always streams over SSE; there is no buffered mode.

Auth is a published-agent chat key (`ao_...`), not the tenant API key. Mint one
with `orca agents keys create <agent>` and pass it with `--key` or
`ORCA_CHAT_KEY`. The gateway base URL comes from `ORCA_GATEWAY_URL` (or the
context `gatewayUrl`) and the tenant slug from `--tenant` or `ORCA_TENANT` (the
org the agent was published under). The key is never echoed.

```sh
export ORCA_GATEWAY_URL=https://<gateway-host>
export ORCA_CHAT_KEY=ao_...                  # from: orca agents keys create support
orca chat support --tenant org_123           # interactive REPL
orca chat support "summarize the last run"   # single-shot, streams to stdout
echo "and the one before?" | orca chat support --conversation conv_123
orca chat support "hi" --json                # ndjson, one gateway event per line
```

In a terminal with no prompt, `orca chat` opens a REPL: a persistent transcript,
a coral prompt marker, assistant text streamed live, and a coral spinner while
the first token is pending. Tool activity is shown subtly, and only when the
published agent sets `exposeToolEvents`. Ctrl-C cancels an in-flight turn first,
then exits from idle. Each turn reuses the conversation id the gateway returns,
so context carries across the session.

With a prompt argument or piped stdin it runs single-shot: the answer streams to
stdout as plain text (no color) and the conversation id is printed to stderr so
scripts can resume it with `--conversation`. Exit codes follow the table below:
1 on a gateway error event, 2 on a missing gateway URL or tenant, 3 on a missing
or rejected chat key, 4 on an unknown agent, 130 on Ctrl-C.

## Usage and sessions

```
orca usage [--window 1h|24h|7d|30d] [--days N] [--meter tokens|cost|runs]
orca sessions list [--agent name] [--limit N]
orca sessions get <id>
```

`orca usage` charts activity over the window as a coral ASCII line graph
(default series `tokens`; `--meter cost|runs` switches it) and summarises
totals, including the tool-call and sandbox-compute meters when the conductor
exposes `GET /api/usage`. The window is served by `GET /api/stats/timeseries`;
`--days N` is shorthand for `--window Nd`. Piped or `--json` output drops the
chart and emits data rows instead (one bucket per line: date, meter, quantity,
cost). Tool-call and sandbox meters are aggregate-only and shown as totals, not
plotted.

`orca sessions` reads the persisted, tenant-scoped session registry
(`GET /api/sessions`); `get <id>` adds the session's recent runs from
`GET /api/sessions/{id}/runs`.

## Observability

```
orca stats [--window 1h|24h|7d|30d]          # summary + per-agent table + hotspots
orca stats agents [--window W]               # per-agent breakdown alone
orca stats hotspots [--window W]             # top token consumers, failing agents, busy runners
orca topology                                # live conductor runner pool as an ASCII tree
orca bundles                                 # capability bundles agents can attach (@fs, ...)
orca apps                                    # Connected Apps providers + connections (read-only)
orca agents changes <name> [--limit N]       # profile change history
```

`orca stats` is the tenant health snapshot: aggregate totals (`GET
/api/stats/summary`) as a labeled field block under the header line, a per-agent
activity table (`GET
/api/stats/agents`, failures colored on the run-status palette), and an
activity-hotspots section (`GET /api/stats/hotspots`). It complements `orca
usage`, which owns the time-series chart and spend; stats carries no cost column
because the summary and per-agent endpoints do not report cost. The default
window is `24h`. In `--json` the three payloads are composed into one object; in
plain mode the top-level `orca stats` prints single-shape key/value totals, and
`agents` / `hotspots` print their own rows.

`orca topology` (`GET /api/topology`) renders the runner pool as an indented
tree: a coral `conductor` root, tree-edge connectors in gray (`├`/`└` on the
Unicode tier, `|-`/`` `- `` on the ASCII tier), each runner's hash in coral with
health and session/latency detail. It returns exit 4 in single-runner mode (the
conductor is not pooled).

`orca bundles` (`GET /api/capability-bundles`) and `orca apps` (`GET
/api/connected-apps/{providers,connections}`) are read-only catalog views; `apps`
degrades to an empty list when the Connected Apps registry is not configured on
the conductor. `orca agents changes <name>` (`GET /api/profiles/{name}/changes`)
lists the profile's audit history (when, action, changed fields).

## Workflows

```
orca workflows list                          # definitions
orca workflows get <definition-id>           # definition + step tree (DAG)
orca workflows delete <definition-id> [--yes]

orca workflows runs [--status s] [--limit N] [--orchestrator run-id]
orca workflows runs get <run-id>             # run + per-step status
orca workflows start <id>                    # definition id: launch a run; run id: hand a pending run to the engine
                                             #   [--prompt text] [--no-autostart]
orca workflows tail <run-id>                 # stream status changes until terminal
orca workflows cancel <run-id> [--yes]
orca workflows repair <run-id> --type abort|retry-node [--node id]

orca workflows schedules                     # list
orca workflows schedules get <id>
orca workflows schedules pause|resume <id>
orca workflows schedules delete <id> [--yes]
```

The definition/run views render steps in execution order as an indented
tree: step names in the default foreground, profiles in coral, dependency
edges (tree connector plus `<- after`, `├` on the Unicode tier and `|-` on the
ASCII tier) in gray. `workflows tail` streams full
run snapshots (not incremental events), diffing them into per-step
transition lines; `tail --json` emits one raw `{type, workflowRun}` frame
per line. Ctrl-C detaches the tail (exit 130); the run keeps going. A tail
of a failed or cancelled run exits 1. There is no server-side replay
buffer, so a reattached tail resumes from the current snapshot.

## Exit codes

| Code | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 0    | success; tailed run finished `ok`                          |
| 1    | API/network error; run finished error/cancelled/interrupted |
| 2    | usage or validation error                                  |
| 3    | auth: missing/invalid key, insufficient role               |
| 4    | named resource not found                                   |
| 130  | detached via Ctrl-C                                        |

## Agent documents

`agents create/update -f` accepts the same schema the dashboard YAML import
validates (`cli/src/lib/profile-schema.ts`, kept in sync with
`dashboard/src/lib/agent-profile-schema.ts`):

```yaml
name: support-bot
runtime: pi              # pi | vercel | claude | codex
model: claude-sonnet-5
systemPrompt: |
  You answer support questions.
skills: [orca-docs]
tools: ["@orchestration"]
mcpServers:
  - name: docs
    transport: http      # http | sse
    url: https://mcp.example.com/docs
fs:
  read: [/agents/self]
sandbox:
  provider: e2b
  resources: { cpu: 2, memoryMB: 1024 }
```

Unknown keys warn but do not block; `--strict` promotes warnings to errors.

## MCP

Manage the tenant's MCP server catalog and wire entries onto agent profiles.
The catalog is the tenant-scoped `/api/mcp-servers` surface; attach/detach are
convenience wrappers that read-modify-write a profile's `mcpServers`.

```
orca mcp list                                            # catalog entries
orca mcp get <name>
orca mcp add --name N --url URL [--transport http|sse] [--header K=V]... [--description D]
orca mcp set <name> [--rename NEW] [--url URL] [--transport t] [--header K=V]... [--clear-headers] [--description D]
orca mcp remove <name> [--yes]
orca mcp test <name>                                     # probe a registered entry
orca mcp test --url URL [--transport t] [--header K=V]... # probe an ad-hoc endpoint
orca mcp attach <agent> <name>                           # copy a catalog entry onto a profile
orca mcp detach <agent> <name> [--yes]                   # remove a server from a profile
```

Server names must match `^[A-Za-z0-9_-]+$` (they are injected into the codex
runtime's TOML config keys); `runner` is reserved. URLs must be absolute
http(s). Header values may be literals, `${VAR}` env references, or
`secret://name` references resolved by the runtime. `mcp test` exits non-zero
when the probe fails, so it is safe to gate scripts on connectivity.

## Skills

Manage the tenant's skill catalog (the open Agent Skills standard) and wire
skills onto agent profiles. List/get/delete are the tenant-scoped
`/api/skills` surface; attach/detach call the conductor's idempotent
`/api/profiles/{name}/skills/{skill}` endpoint after a read that validates the
agent and reports whether the skill is already present.

```
orca skills list
orca skills get <name> [--resource path]         # metadata + SKILL.md body, or one bundled file
orca skills import <path> [--dry-run] [--force]  # Agent Skills folder (must contain SKILL.md)
orca skills delete <name> [--yes]
orca skills attach <agent> <skill>               # add a skill to an agent profile
orca skills detach <agent> <skill>               # remove a skill from an agent profile
```

`import` uploads the folder for a server-side dry-run (validation + preview),
then commits it; `--dry-run` stops after the preview and `--force` overwrites an
existing skill. Folder import is gated to member+ API keys. Attaching a skill
the catalog does not know exits 2; a missing agent exits 4.

## Pools

Manage agent pools: named groups of profiles that share an FS workspace under
`/pools/{name}/**`, layered on top of each member's profile sandbox with
role-aware partitions. Backed by the tenant-scoped `/api/pools` surface.

```
orca pools list
orca pools get <name>
orca pools create <name> [--description D] [--member profile[:role]]... \
                         [--read glob]... [--write glob]... [--delete glob]... [--deny glob]...
orca pools delete <name> [--yes]
orca pools members add <pool> <profile> [--role lead|member|observer]
orca pools members remove <pool> <profile> [--yes]
```

Roles are `lead`, `member`, or `observer`. `--member alpha:lead` seeds a pool
at creation; `members add/remove` adjust the roster afterwards (both idempotent).
The API has no per-pool GET, so `pools get` filters the list and exits 4 when
the name is unknown. FS globs support the `{self}`, `{pool}`, and `{role}`
tokens the runtime substitutes at policy compile time.

## Secrets

Manage the tenant's envelope-encrypted secrets (`/api/secrets`). The store is
write-only from the CLI: values are never returned by the API, never printed,
and never placed in `--json` output or error text. List and get show metadata
only (name, key hint, algorithm, timestamps).

```
orca secrets list
orca secrets set <name> [--value V] [--key VAR_NAME] [--description D]
orca secrets delete <name> [--yes]
```

`secrets set` is an upsert (`PUT /api/secrets/{name}`). The value comes from
`--value`, else from piped stdin (a single trailing newline is stripped, so
`printf %s val | orca secrets set NAME` and `echo val | ...` both round-trip),
else from a hidden masked prompt in a terminal. `--key` records the canonical
variable name the value populates (e.g. `ANTHROPIC_API_KEY`). Secrets require
`POSTGRES_DSN` + a master key server-side; an unconfigured deployment returns
503 (mapped to exit 1). These endpoints are admin-gated: a member key exits 3.

## Billing

Read the prepaid credit wallet and set the tenant's monthly spend cap. The
payment/checkout flow is intentionally out of scope.

```
orca billing wallet                      # read-only credit balance
orca billing cap                         # show the monthly cap and accrued spend
orca billing cap set <amount> [--email A] [--yes]   # amount in dollars, or "default" to clear
```

Amounts are dollars parsed into cents (`10`, `10.5`, `10.50`, `$10`, `1,000`);
anything else, a negative, or more than two decimal places exits 2. `set`
confirms before writing unless `--yes`, and warns when the new cap is below the
current month's spend (the platform gates run creation on the cap fail-closed,
so runs would be blocked until reset). `cap set default` clears the tenant
override and reverts to the system default. Writing the cap is admin-gated (a
member key exits 3).

## Storage

Manage the tenant's storage bucket (the dashboard Files page). Backed by the
tenant-scoped `/api/storage` surface; the server jails each tenant to its own
subtree. Object keys may contain slashes, which stay literal path separators
(each segment is URL-encoded, matching the dashboard).

```
orca storage info                        # bucket usage summary
orca storage ls [prefix] [--limit N]     # immediate folders/files in a TTY; flat rows when piped
orca storage browse [prefix]             # interactive filesystem-style navigation
orca storage get <key> [--output FILE]   # bytes to stdout when piped, or to a file
orca storage put <key> <file> [--content-type T]   # upload (upsert; overwrites)
orca storage rm <key> [--yes]            # trailing "/" deletes a whole prefix
```

`get` returns the object bytes: piped, they stream raw to stdout and nothing
else; with `--output` they are written verbatim to a file. To a live terminal
the CLI refuses to dump a binary object (base64/non-text Content-Type/NUL bytes)
and asks for `--output` or a pipe; text objects print as-is. `--json` emits the
raw `{key, encoding, content, ...}` payload (binary is base64 there). `put`
sends the file body raw with a Content-Type guessed from the extension (override
with `--content-type`); uploads are an upsert and are capped at the server's 8
MiB inline limit (413). `rm` confirms unless `--yes`; a key ending in `/` is a
prefix delete and the reported count is how many objects were removed.

## Memory

Inspect agent memories and the cross-profile memory bank
(`/api/profiles/{name}/memories` and `/api/memory-bank`). Memories are written
by agents (or the dashboard's extraction form), so the CLI is read/search/delete
only, with no create/update.

```
orca memory list <agent> [--limit N] [--offset N]
orca memory search <agent> <query> [--limit N] [--min-score N]
orca memory show <agent> <id>
orca memory delete <agent> <id> [--yes]
orca memory bank                         # every memory, grouped by profile
orca memory bank stats                   # bank-wide totals and per-profile counts
```

`search` scores by relevance (recency, usage, topic); `--min-score` filters weak
matches. `bank` flattens the grouped snapshot into one table carrying each
entry's profile; `bank stats` is the lightweight totals view. `delete` confirms
unless `--yes`. A missing memory exits 4; an unconfigured bank returns 503
(mapped to exit 1).

## Development

- `npm test` - vitest (SSE parser byte-boundary cases, config permissions,
  command handlers against a fetch mock, Ink components via
  ink-testing-library)
- `npm run lint` / `npm run typecheck`
- Module layout: `lib/` (no Ink imports) -> `commands/` -> `ui/` (theme'd
  Ink components; design tokens in `src/ui/theme.ts` mirror
  `dashboard/src/index.css`)
- Endpoint contract: `docs/openapi.sdk.yaml`
