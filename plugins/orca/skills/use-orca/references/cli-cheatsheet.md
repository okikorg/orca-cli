# orca CLI cheatsheet

Global contract, gh-style:

- `--json` on any command: machine-readable JSON on stdout. `chat --json` emits NDJSON, one session event per line.
- stdout not a TTY: plain tab-separated lines, no color.
- Exit codes: 0 ok, 1 failure, 2 usage, 3 auth, 4 not found or gone, 130 interrupt. Errors always on stderr.
- Config: contexts in `~/.config/orca/config.json` (kubectl-style, local only). Precedence: flag > env > config file > baked-in production default.
- Env: `ORCA_API_KEY`, `ORCA_API_URL`, `ORCA_CONTEXT`, `ORCA_DASHBOARD_URL`, `ORCA_CONFIG_DIR`.
- CI needs no config file: `ORCA_API_KEY=... orca agents list --json`.
- `<agent>` is an agent id (`agent_...`) or a unique agent name.
- Lists: `--limit n` (1 to 100), `--after <id>` (the cursor the previous page printed), `--all`.

## Setup

```bash
orca login                          # device login: a code + dashboard link to approve
orca login --no-browser             # print the code and link only
orca login --with-token <orca_sk_key>   # CI / pre-minted key
orca whoami --json                  # tenant, actor, role (and agent, for a published agent's key)
orca auth status --json             # context + key validity
orca auth logout [--revoke]         # clear (and optionally revoke) the stored key
orca context use <name>             # switch contexts (e.g. prod vs local)
orca doctor --json                  # health checks with fixes; --strict promotes warnings
orca update                         # self-update the standalone binary
```

## Agents, sessions, chat

```bash
orca agents list --json
orca agents get <agent> --json
orca agents create -f agent.yaml --json         # YAML or JSON POST /v1/agents body; - for stdin
orca agents update <agent> -f fields.yaml       # only the fields in the file change
orca agents delete <agent> --yes

orca chat <agent> "prompt"                      # new session, one turn
orca chat <agent> --session <id> "prompt"       # continue a session
orca chat <agent> --sandbox | --template <id> | --vault <id> "prompt"
orca sessions list [--agent <agent>] --json
orca sessions get <id> --json
orca sessions create --agent <agent> [--sandbox] [--template id] [--vault id] --json
orca sessions items <id> [--limit n] --json
orca sessions delete <id> --yes
```

## Skills, vaults, files

```bash
orca skills list --json
orca skills get <id> --json
orca skills create <folder> --json              # Agent Skills folder with SKILL.md
orca skills delete <id> --yes

orca vaults list --json
orca vaults create <name>                       # admin
orca vaults credentials list <vault> --json
printf %s "$TOKEN" | orca vaults credentials add <vault> --name n --server https://mcp.example.com
orca vaults credentials delete <vault> <id> --yes

orca files list --json
orca files upload <path> --json
orca files download <id> -o <path>              # -o - for stdout
orca files delete <id> --yes
```

## Kits and publishing

```bash
orca kits list --json
orca kits make --name n [--agent a]... [--skill id]... [--template id]... [--readme file]
orca kits edit <kit-id> [--name n] [--description d] [--agent a]...
orca kits publish <kit-id> --json               # public id + share link
orca kits withdraw <kit-id>
orca kits show <link|public-id> --json          # contents, asset keys, credentials to add
orca kits copy <link|public-id> [--name key=name]... [--skip key]... [--dry-run] --yes

orca publish create <agent> --label l           # admin; scoped key secret shown once
orca publish list <agent> --json
orca publish revoke <key-id> --yes              # the last key's revocation unpublishes
```

## Account

```bash
orca billing wallet --json                      # balance (micro-USD), plan, period, packs
orca billing buy pro|max|pack:<cents>           # admin; prints the checkout link
orca billing manage                             # admin; prints the billing portal link
orca usage [--days n] [--group-by model|provider|credential|session|agent] [--session id] --json
orca usage events [--meter m] --json            # raw rows with cost_micro_usd
orca keys list --json                           # API keys, with the agent a scoped key reaches
orca keys create <name>                         # secret on stdout when piped
orca keys revoke <id> --yes
```

## Key minting for scripts

```bash
ORCA_API_KEY=$(orca keys create ci </dev/null)   # the secret alone on stdout when piped
```
