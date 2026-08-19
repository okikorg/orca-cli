---
name: use-orca
description: Run AI agents in the cloud with Orca (orcapods.ai). Use this skill whenever the user mentions Orca or orcapods, wants to deploy or run an agent in the cloud, create a cloud agent, publish an agent as an API, check agent runs or usage, or manage Orca skills, storage, or workflows, even if they do not say "Orca" explicitly but are clearly working against the Orca platform.
---

# Use Orca

Orca is a cloud platform for running AI agents in production: define an agent as a profile, run it with sandboxed execution, spend controls, persistent sessions, and streaming output, behind one API. The `orca` CLI is the primary tool; an MCP server (`orca mcp serve`) exposes the same control plane as tools.

## Preflight

Check the CLI is installed and healthy before anything else:

```bash
orca doctor --json
```

If `orca` is missing, install it (standalone binary, no Node required):

```bash
curl -fsSL https://orcapods.ai/install.sh | sh
```

Exit codes everywhere: 0 ok, 1 failure, 2 usage, 3 auth, 4 not found, 130 interrupt. All errors go to stderr; stdout stays machine-clean.

## Authentication

Interactive or headless, one command:

```bash
orca login
```

In a headless or agent context this automatically uses the device flow: it prints a one-time code and a URL. Relay BOTH to the user verbatim and wait; the command keeps polling until they approve in the browser (on any device) and then stores the key itself. Do not paste or echo API keys.

For CI or when a key already exists, set environment variables instead: `ORCA_API_KEY` (and `ORCA_API_URL` for self-hosted). Verify auth with:

```bash
orca whoami --json
```

## Golden paths (always pass --json when parsing)

Create an agent, run it, follow the output:

```bash
orca agents list --json
orca agents create -f agent.yaml --json        # YAML or JSON profile; use - for stdin
orca run my-agent "summarize the open issues" --json --detach   # prints the run id and exits
orca runs tail <runId> --json                  # NDJSON, one event per line, exits with the run
orca runs get <runId> --json
```

Without `--detach`, `orca run` streams the run to completion; with it, poll via `runs get` or `runs tail`. Reuse a conversation with `orca run my-agent "..." --session <sessionId>`. Skills extend agents (`orca skills list`, `orca skills attach <agent> <skill>`). Storage is a per-tenant object store (`orca storage ls`, `get <key>`, `put <key> <file>`). Publish an agent as a public chat endpoint with `orca agents publish <name>`.

Account status:

```bash
orca billing wallet --json     # credit balance
orca billing cap --json        # monthly spend cap
orca usage --json              # usage timeseries
```

## MCP server (richer sessions)

For extended work, register Orca's MCP server once:

```bash
claude mcp add orca -- orca mcp serve
```

This exposes tools for everything above (whoami, list/create/update agents, run_agent, wait_for_run long-polling, skills, storage, publish, get_usage) plus `api_request`, a raw authenticated escape hatch to any `/api/*` operation, documented by the live OpenAPI spec at the `orca://openapi` resource or https://api.orcapods.ai/api/openapi.yaml.

## References

- `references/cli-cheatsheet.md`: the full command surface with flags and JSON output shapes.
- `references/api-cookbook.md`: api_request and curl recipes for operations beyond the golden paths (pools, workflows, secrets, memory, spend caps).

## Troubleshooting

- Exit 3 or 401: run `orca login` again (or check `ORCA_API_KEY`).
- "does not support headless login": the target conductor predates device login; use `orca login --with-token <key>` with a key minted in the dashboard (Settings, then API Keys).
- Anything else: `orca doctor --json` names the failing check and the fix.
