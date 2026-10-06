# orca CLI

Manage agents, sessions, and kits on the Orca platform from the terminal.
TypeScript + commander for command routing, Ink (React) for TTY rendering, and
the official [`openai`](https://www.npmjs.com/package/openai) package for
Orca's OpenAI-compatible Agents API.

Running `orca` with no arguments shows a one-line brand banner and the command
list. In a terminal, list and detail views are borderless: hierarchy comes from
whitespace and weight, not boxes. Each view opens with a bold mint title and
` · `-separated metadata in subtle gray, content rows indent two spaces, and
list views end with a subtle `next:` hint teaching follow-up commands. Mint is
the brand accent (`src/ui/theme.ts`); primary actions use the terminal's inverse
foreground, while piped or `--json` output stays plain and
machine-clean. Unicode glyphs are restricted to a CP437/Latin-1 safe tier and
fall back to ASCII when the locale is not UTF-8 or `ORCA_ASCII=1` is set.
`NO_COLOR` is honored, independently of the glyph tier.

## Install

End users install a standalone binary (no Node required) via the landing domain:

```sh
curl -fsSL https://orcapods.ai/install.sh | sh
```

The script detects your OS/arch, downloads the matching binary, verifies its
SHA-256 checksum, and installs to `~/.local/bin/orca`. Pin a version with
`ORCA_VERSION=cli-v1.0.0` or change the target directory with `ORCA_INSTALL_DIR`.
Windows users download `orca-windows-x64.tar.gz` from the
[releases page](https://github.com/okikorg/orca-cli/releases).

This repo is the public home of the CLI source and its release binaries; the
Orca platform it talks to is a separate, private service.

### Updating

`orca update` updates a standalone binary to the latest release in place: it
queries the GitHub Release, downloads the matching `orca-<os>-<arch>` binary,
verifies its SHA-256 against `SHA256SUMS`, and atomically swaps the running
executable. It needs no Orca credentials, so it also rescues a CLI too old for
the server (the server answers an old CLI's paths with "This CLI is too old for
Orca. Run orca update.").

```sh
orca update                   # update to the latest release
orca update --check           # report whether a newer version exists, don't install
orca update --tag cli-v1.0.0  # install a specific version (also accepts 1.0.0)
orca update --force           # reinstall the target version even if already current
```

`orca -v` prints the version and, in an interactive terminal, appends a hint
when a newer release is available. The check is cached for ~24h under the config
dir (`update-check.json`), is skipped in scripts (non-TTY stderr), and is
disabled entirely by `ORCA_NO_UPDATE_CHECK`. Both commands honor `GITHUB_TOKEN`
to lift the anonymous GitHub API rate limit.

Self-update is only available for the standalone binary. A source checkout
updates with `git pull`; Windows can't replace a running `.exe`, so re-download
`orca-windows-x64.tar.gz` from the releases page. In each of these cases
`orca update` prints the right instructions instead of attempting a swap. The
package is not published to npm; the installer and a source checkout are the
two supported paths.

### Releasing binaries

Binaries are Bun-compiled (each embeds the Bun runtime, ~60-100 MB raw / ~23 MB
gzipped) and cross-compiled for all platforms from one CI runner. Cut a release
by pushing a tag; the `release-cli` workflow builds, packages, and publishes the
GitHub Release (default `GITHUB_TOKEN`, no extra secret needed):

```sh
git tag cli-v1.0.0 && git push origin cli-v1.0.0
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

The CLI authenticates with an Orca API key (`orca_sk_...`). `orca login` (an
alias of `orca auth login`) signs in with a one-time code (RFC 8628 device
login), which works everywhere, including inside coding agents and over SSH:

1. The CLI prints a code and a link to the dashboard's `/device` page, and opens
   the link when a person is at the terminal.
2. Signed in to the dashboard, you check the code and approve (or deny) it.
3. The CLI's next poll receives a new API key with your role, shown once and
   stored locally. No secret is stored on the server before that poll.

For CI, `--with-token orca_sk_...` stores a key minted elsewhere (`orca keys
create`, or the dashboard) without any flow. Keys are stored per context in
`~/.config/orca/config.json` (chmod 600).

```sh
orca login                                   # device login; defaults to the Orca production API
orca login --no-browser                      # print the code and link only
orca login --api-url http://localhost:8080   # a local or self-hosted server
orca whoami                                  # tenant, actor, and role the stored key acts as
orca auth status
orca auth logout --revoke                    # revoke the key server-side, then clear it
```

`orca login` defaults to the production API (`https://api.orcapods.ai`); pass
`--api-url` for a self-hosted or local server. The login is named after this
machine ("CLI on laptop", or "Claude Code on laptop" when a coding agent drives
it): the dashboard's approval page shows that name, and the minted key carries
it. The dashboard origin comes from the server's verification link and is
stored with the context; `billing buy` and `billing manage` send it so the
checkout returns there. Kit share links come from the server.

`orca auth logout --revoke` revokes the key on the server before forgetting it.
If the server refuses (a member's CLI key may not be theirs to revoke) or
cannot be reached, the key keeps working, so the CLI keeps it too and says so;
plain `orca auth logout` forgets it here only.

Contexts work like kubectl contexts, and are local only: `orca context list`,
`orca context use prod`, or per-invocation `orca --context prod agents list`.

## Doctor

`orca doctor` is a preflight that verifies everything the other commands need
and prints a concrete fix for every problem it finds. It runs read-only probes
only (it never creates a session, key, or any resource), timeboxes each network
probe to 3s so it never hangs, and completes in a few seconds.

```sh
orca doctor            # Doctor header line, one row per check (status glyph + word), fix lines under failures
orca doctor --json     # array of { name, status, message, fix? }
orca doctor --strict   # promote warnings to failures
```

It checks: Node version (>= 22), the color/TTY situation (informational),
whether the config file exists, parses, and is `chmod 600`, how the active
context resolves (which field came from a flag, env var, file, or baked default),
server reachability (`GET /health`, with latency), the API key's presence and
validity and role (`GET /api/whoami`), a credit preflight (`GET
/api/billing/wallet`: an empty wallet warns, since turns on Orca's model keys
are refused while your own provider keys keep working), and the dashboard URL
used for kit share links. Each check reports `pass`, `warn`, `fail`, or `skip`.
The exit code is `0` when nothing failed (warnings are allowed) and `1` when any
check failed; `--strict` also fails on warnings.

Environment overrides (all optional, win over the config file):

| Variable             | Meaning                                                |
| -------------------- | ------------------------------------------------------ |
| `ORCA_API_KEY`       | Orca API key                                           |
| `ORCA_API_URL`       | server base URL (defaults to the Orca production API)  |
| `ORCA_DASHBOARD_URL` | dashboard base URL, for kit share links                |
| `ORCA_CONTEXT`       | context name                                           |
| `ORCA_CONFIG_DIR`    | config directory (default XDG)                         |
| `ORCA_ASCII`         | set to `1` to force ASCII glyphs (no Unicode tier)     |

CI needs no config file: `ORCA_API_KEY=... ORCA_API_URL=... orca agents list --json`.

## Commands

`[x]` marks a positional that opens an interactive picker when omitted in a
terminal; in a script it is required (exit 2). An `<agent>` is an agent id or
the name of exactly one agent: the CLI asks the server for an agent with that
id first, then matches names. A name several agents share is refused with
their ids (exit 2); an unknown one is not found (exit 4).

```
orca login | orca auth login [--api-url u] [--label l] [--no-browser] [--with-token orca_sk_...]
orca whoami | orca auth whoami
orca auth status
orca auth logout [--revoke] [--yes]
orca context list|use [name]|show

orca chat [agent] [prompt...] [--session id] [--sandbox] [--template id] [--vault id]...

orca agents list
orca agents get [agent]
orca agents create -f agent.yaml           # YAML or JSON; - for stdin
orca agents update <agent> -f fields.yaml  # only the fields in the file change
orca agents delete [agent] [--yes]

orca sessions list [--agent agent]
orca sessions get <id>
orca sessions create --agent <agent> [--sandbox] [--template id] [--vault id]...
orca sessions items <id> [--limit n]
orca sessions delete <id> [--yes]

orca usage [--days n] [--group-by model|provider|credential|session|agent] [--session id] [--meter m]
orca usage events [--meter m]

orca skills list|get <id>|delete <id> [--yes]
orca skills create <folder>                # an Agent Skills folder with SKILL.md

orca vaults list|create <name>|delete <id> [--yes]
orca vaults credentials list <vault>
orca vaults credentials add <vault> --name n --server https://... [--token t]
orca vaults credentials delete <vault> <id> [--yes]

orca files list
orca files upload <path> [--name filename]
orca files download <id> [-o path|-]
orca files delete <id> [--yes]

orca kits list
orca kits make --name n [--description d] [--author who] [--readme file] [--agent a]... [--skill id]... [--template id]...
orca kits edit <kit-id> [same flags]       # any selection flag replaces the whole selection; publish again to update the page
orca kits publish|withdraw <kit-id>
orca kits show <link|public-id>            # no login needed
orca kits copy <link|public-id> [--name key=name]... [--skip key]... [--dry-run] [--yes]

orca keys list
orca keys create [name]
orca keys revoke <id> [--yes]

orca billing wallet
orca billing buy pro|max|pack:<cents> [--no-open]   # admin; opens the checkout
orca billing manage [--no-open]                     # admin; opens the billing portal

orca mcp serve
orca doctor [--strict]
orca update [--check] [--tag t] [--force]
```

List commands share `--limit N` (1 to 100, default 10), `--after <id>` (the
cursor a previous page printed), and `--all` (follow the cursor through every
page, up to 10,000 rows). `kits list` returns everything at once.

Every list/get command supports `--json` (raw API payloads, stdout only).
When stdout is not a TTY, output degrades to uncolored tab-separated lines,
so `orca agents list | cut -f1` works.

Key minting prints the secret exactly once. In a pipe, stdout carries only the
secret: `ORCA_API_KEY=$(orca keys create ci </dev/null)`.

## Agents, sessions, and chat

Agents, sessions, skills, vaults, and files live on the server's `/v1` Agents
API, which the CLI calls through the `openai` package exactly as any OpenAI
client does. `agents create -f` takes the `POST /v1/agents` body; the model
names its provider with a prefix:

```yaml
model: openai/gpt-5          # or anthropic/..., openrouter/..., vercel/..., cheaperinference/...
name: support
instructions: |
  You answer support questions.
tools:
  - type: mcp
    server_label: docs
    transport: { type: http, server_url: https://mcp.example.com/docs }
    credential_id: cred_123  # from: orca vaults credentials add
reasoning: { effort: medium }
```

Only the shape is checked locally; the server validates every field and the
CLI prints its message and the field it is about.

`orca chat <agent> [prompt]` runs a turn on a `/v1` session with your API key.
Without `--session` it creates a session of the agent first (no environment by
default; `--sandbox` for a hosted sandbox, `--template id` to build it from an
environment template, `--vault id` to let it use a vault's credentials).

```sh
orca chat support                            # interactive REPL
orca chat support "summarize the open tickets"   # one turn, streamed to stdout
echo "and the oldest?" | orca chat support --session sess_123
orca chat support "hi" --json                # NDJSON, one session event per line
```

In a terminal with no prompt, `orca chat` opens a REPL: a persistent transcript,
a mint prompt marker, assistant text streamed live, and the agent's tool
activity grouped by intent. The session is created with the first message and
every turn reuses it. Ctrl-C cancels an in-flight turn (on the server too), then
exits from idle, printing the command that resumes the session.

With a prompt argument or piped stdin it runs one turn: the answer streams to
stdout as plain text and the session id is printed to stderr (`session
sess_...`), so scripts can resume with `--session`, also when the turn fails or
is refused. A failed turn exits 1 after printing what arrived; Ctrl-C cancels
the turn on the server and exits 130.

## Usage and billing

Every money figure is the server's: usage rows are priced when they are written,
in micro-USD, and the CLI formats them without any arithmetic of its own, by the
same rule as the dashboard: dollars and cents at a cent or more (`$1,234.57`),
every digit under a cent (`$0.000047`). Every usage figure comes from
`/api/usage`, a session's included: `orca sessions get` shows its cost, tokens
by model, web searches and machine time from there, never from the session
object. Whether paid work is paused is the server's verdict too: `orca billing
wallet` shows `paid_work_paused` and the plan's minimum balance, and `orca
doctor` warns on it, so a balance above zero but under the minimum reads as
paused, as the server treats it.

```sh
orca usage                                   # last 30 days: cost, meters, daily chart
orca usage --days 7 --group-by agent         # also totals per agent
orca usage --session sess_123                # one session
orca usage events --meter model_tokens       # raw rows, each with its cost
orca billing wallet                          # balance, plan, period, packs on sale
orca billing buy pro                         # checkout for the Pro plan
orca billing buy pack:2000                   # checkout for the $20 credit pack
orca billing manage                          # change or cancel the plan
```

`buy` and `manage` print the Polar link and open it in a browser at a terminal
(`--no-open` to only print it); both are admin. In a pipe, stdout carries only
the link.

## Kits

A kit bundles agents, skills, and environment templates into a shareable,
versioned snapshot. Publishing mints a public id (`kit-...`) and a share link on
the dashboard; no secret ever enters a kit, so a copy lists the credentials to
add.

`--author` sets who the kit's page says it is by (up to 100 characters; pass
`--author ""` to clear it). Like every other edit, a changed author reaches the
public page on the next publish, and `kits show` prints the author and the share
link the server gives.

```sh
orca kits make --name "Support desk" --author "Okik Labs" --agent support --skill skill_123
orca kits publish kit_abc                    # prints the share link
orca kits show https://app.orcapods.ai/kits/kit-xxxxxxxxxxxxxxxxx
orca kits copy kit-xxxxxxxxxxxxxxxxx --dry-run
orca kits copy kit-xxxxxxxxxxxxxxxxx --name agent-1=my-support --skip skill-1 --yes
```

`copy` copies every asset under its own name unless renamed with `--name
key=name` or left out with `--skip key` (keys come from `kits show`). A skill
renamed this way has its `SKILL.md` renamed too; skill names use only letters,
digits, `_` and `-`. A name already used by the same kind fails the whole copy
with "Name taken" and nothing is copied; rename and run it again. In a script,
pass `--yes` (without it, a non-interactive run exits 2).

Each credential a copy needs says where it goes: an MCP server's credential in
a vault (`orca vaults credentials add`), an environment variable on the copied
template, which the copy names.

## Use from Claude Code (plugin, skill, MCP)

The repo doubles as a Claude Code plugin marketplace. The `orca` plugin ships
the `use-orca` skill (install, login, golden-path commands) and auto-registers
the Orca MCP server:

```
claude plugin marketplace add okikorg/orca-cli
claude plugin install orca@orca
```

Or register just the MCP server against an existing install:

```
claude mcp add orca -- orca mcp serve
```

`orca mcp serve` speaks MCP over stdio with one tool per CLI action: identity
and keys, agents, sessions and `chat` (which sends a message and waits for the
reply), skills, vaults, files, usage and billing, and kits. The
commands that only touch this machine (login, logout, context, doctor, update)
have no tool. Other MCP clients (Cursor, Codex) use `{"command": "orca",
"args": ["mcp", "serve"]}`. Login for agent contexts is `orca login` (device
login).

## Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | success                                                    |
| 1    | API/network error; a chat turn failed                      |
| 2    | usage or validation error                                  |
| 3    | auth: missing/invalid key, insufficient role               |
| 4    | named resource not found or gone                           |
| 130  | interrupted via Ctrl-C                                     |

## Development

- `npm test` - vitest (config permissions, command handlers against a fetch
  mock that also serves the `openai` package, Ink components via
  ink-testing-library)
- `npm run lint` / `npm run typecheck`
- Module layout: `lib/` (no Ink imports) -> `commands/` -> `ui/` (theme'd
  Ink components; design tokens in `src/ui/theme.ts`)
- Server contract: the Orca server's README documents the `/api` routes; `/v1`
  is the OpenAI Agents API as typed by the `openai` package
