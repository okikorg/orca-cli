# orca CLI cheatsheet

Global contract, gh-style:

- `--json` on any command: machine-readable JSON on stdout. Streaming commands (`runs tail`, `chat`) emit NDJSON, one JSON object per line.
- stdout not a TTY: plain tab-separated lines, no color.
- Exit codes: 0 ok, 1 failure, 2 usage, 3 auth, 4 not found, 130 interrupt. Errors always on stderr.
- Config: contexts in `~/.config/orca/config.json` (kubectl-style). Precedence: flag > env > config file > baked-in production default.
- Env: `ORCA_API_KEY`, `ORCA_API_URL`, `ORCA_CONTEXT`, `ORCA_DASHBOARD_URL`, `ORCA_CONFIG_DIR`.
- CI needs no config file: `ORCA_API_KEY=... orca agents list --json`.

## Setup

```bash
orca login                          # browser flow on a desktop; device flow when headless
orca login --headless               # force the device flow (code + URL, approve anywhere)
orca login --with-token <ao_key>    # CI / pre-minted key
orca whoami --json                  # tenant, role, credential kind, key id
orca auth status --json             # context + key validity
orca auth logout [--revoke]         # clear (and optionally revoke) the stored key
orca context use <name>             # switch contexts (e.g. prod vs local)
orca doctor --json                  # health checks with fixes; --strict promotes warnings
```

## Agents (profiles)

```bash
orca agents list --json
orca agents get <name> --json
orca agents create -f agent.yaml [--strict]     # YAML or JSON; - for stdin
orca agents update <name> -f agent.yaml
orca agents delete <name>
orca agents changes <name> --json               # revision history
orca agents publish <name>                      # expose as a public chat endpoint
orca agents unpublish <name>
orca agents keys list|create|revoke <agent>     # chat keys for the published endpoint
```

## Runs

```bash
orca run <agent> <prompt...> [--title t] [--session id] [--detach] --json
orca runs list [--limit n] --json
orca runs get <id> --json                       # status + buffered events
orca runs tail <id> --json                      # NDJSON stream, exits with the run
orca runs cancel <id>
orca sessions list --json                       # persisted conversation state
orca sessions get <id> --json
```

## Skills, storage, secrets, memory

```bash
orca skills list --json
orca skills get <name> --json
orca skills import <path>                       # SKILL.md folder or package
orca skills attach <agent> <skill>
orca skills detach <agent> <skill>

orca storage info --json
orca storage ls [prefix] [--limit n] --json
orca storage get <key> [-o file]
orca storage put <key> <file> [--content-type t]
orca storage rm <key>

orca secrets ...                                # tenant secrets (see orca secrets --help)
orca memory ...                                 # agent memory bank
```

## Workflows

```bash
orca workflows list --json
orca workflows start <id>
orca workflows runs [--limit n] --json
orca workflows tail <run-id> --json
orca workflows cancel <run-id>
orca workflows schedules list|get|pause|resume|delete <id>
```

## Account

```bash
orca billing wallet --json          # credit balance
orca billing cap --json             # monthly spend cap
orca billing cap set <amount>
orca usage --json                   # usage timeseries
orca stats ...                      # summary, per-agent, hotspots
orca keys list|create|revoke        # control-plane API keys (ao_...)
```

## Key minting for scripts

```bash
ORCA_API_KEY=$(orca keys create ci </dev/null)   # plaintext token on stdout when piped
```
