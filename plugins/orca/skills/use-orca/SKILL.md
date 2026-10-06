---
name: use-orca
description: Run AI agents in the cloud with Orca (orcapods.ai). Use this skill whenever the user mentions Orca or orcapods, wants to deploy or run an agent in the cloud, create a cloud agent, chat with one, share or copy a kit, check usage or credit, or manage Orca skills, vaults, or files, even if they do not say "Orca" explicitly but are clearly working against the Orca platform.
---

# Use Orca

Orca is a cloud platform for running AI agents in production: define an agent once, then talk to it in sessions with optional hosted sandboxes, MCP tools, skills, and credit-based billing, behind an OpenAI-compatible Agents API (`/v1`). The `orca` CLI is the primary tool; an MCP server (`orca mcp serve`) exposes the same actions as tools.

## Preflight

Check the CLI is installed and healthy before anything else:

```bash
orca doctor --json
```

If `orca` is missing, install it (standalone binary, no Node required):

```bash
curl -fsSL https://orcapods.ai/install.sh | sh
```

If a command says "This CLI is too old for Orca", run `orca update`.

Exit codes everywhere: 0 ok, 1 failure, 2 usage, 3 auth, 4 not found or gone, 130 interrupt. All errors go to stderr; stdout stays machine-clean.

## Authentication

One command, in a terminal or inside an agent:

```bash
orca login
```

It prints a one-time code and a link to the Orca dashboard. Relay BOTH to the user verbatim and wait; the command keeps polling until they approve the code in the dashboard (signed in, on any device) and then stores the new key itself. Do not paste or echo API keys.

For CI or when a key already exists, set environment variables instead: `ORCA_API_KEY` (an `orca_sk_...` key) and `ORCA_API_URL` for self-hosted. Verify auth with:

```bash
orca whoami --json
```

## Golden paths (always pass --json when parsing)

Create an agent and talk to it:

```bash
orca agents list --json
orca agents create -f agent.yaml --json      # the POST /v1/agents body: model (with a provider prefix, e.g. openai/gpt-5), name, instructions, tools
orca chat <agent> "summarize the open issues"     # one turn; the reply on stdout, "session <id>" on stderr
orca chat <agent> --session <id> "and the oldest?"  # continue the same session
orca sessions items <id> --json              # the conversation so far
```

`<agent>` is an agent id or the name of exactly one agent (the server says which; a shared name is refused with the ids). Add `--sandbox` (or `--template <id>`) to `chat` for a hosted sandbox, and `--vault <id>` to let the session use a vault's MCP credentials (`orca vaults credentials add`).

Share and reuse setups as kits:

```bash
orca kits make --name "Support desk" --agent support --json
orca kits publish <kit-id> --json            # prints the public id and share link
orca kits copy <link-or-public-id> --dry-run --json
```

Account status (every figure is the server's, in micro-USD; never recompute costs):

```bash
orca billing wallet --json                   # balance, plan, packs on sale
orca usage --json                            # cost per meter over the last 30 days
orca usage --group-by agent --json
```

Buying credit or a plan (`orca billing buy pro|max|pack:<cents>`) returns a checkout link: give it to the user to open; never try to pay.

## MCP server (richer sessions)

For extended work, register Orca's MCP server once:

```bash
claude mcp add orca -- orca mcp serve
```

It exposes one tool per CLI action: whoami and keys, agents, sessions, `chat` (sends a message and waits for the reply, returning the session id), skills, vaults, files, usage and billing, and kits.

## References

- `references/cli-cheatsheet.md`: the full command surface with flags.
- `references/api-cookbook.md`: the raw API (the `/v1` Agents API through any OpenAI client, and the `/api` routes with curl) for anything beyond the CLI.

## Troubleshooting

- Exit 3 or 401: run `orca login` again (or check `ORCA_API_KEY`).
- "Out of Orca credit" (HTTP 429, or a turn that fails with it): paid work is paused because the balance is under the plan's minimum; `orca billing wallet --json` shows `paid_work_paused` and `min_balance_micro_usd`. Add credit, then continue the session.
- "does not support device login": the API URL does not point at an Orca server; check `orca auth status`, or use `orca login --with-token <key>` with a key minted in the dashboard.
- Anything else: `orca doctor --json` names the failing check and the fix.
