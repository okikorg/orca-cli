---
name: use-orca
description: Run AI agents in the cloud with Orca (orcapods.ai). Use this skill whenever the user mentions Orca or orcapods, wants to deploy or run an agent in the cloud, create a cloud agent, chat with one, read or copy a kit, check usage or credit, or manage Orca skills, vaults, or files, even if they do not say "Orca" explicitly but are clearly working against the Orca platform.
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

Talk to an agent the user names: pass the name straight to `chat`. Do not list agents first; a name needs no lookup.

```bash
orca chat margin-check "check this deal"     # one turn; the reply on stdout, "session <id>" on stderr
orca chat margin-check --session <id> "and the freight?"  # continue the same session
orca sessions items <id> --json              # the conversation so far
```

Create an agent:

```bash
orca agents create -f agent.yaml --json      # the POST /v1/agents body: model (who pays: orca/openrouter/<id> or <provider>/<id>), name, instructions, tools
orca agents list --json                      # only when the user does not know the agent's name
```

`<agent>` is an agent id or the name of exactly one agent (the server says which; a shared name is refused with the ids). Add `--sandbox` (or `--template <template>`) to `chat` for a hosted sandbox, and `--vault <vault>` to let the session use a vault's MCP credentials (`orca vaults credentials add`); a template or vault is an id or a name, like an agent.

Pick a model name for `agents create` from `orca models --json` (`--payer orca` for Orca credit, `--payer anthropic` for one provider's key).

Work on a file in a sandbox, and get the results back:

```bash
orca chat <agent> --file sales.csv "Chart /workspace/sales.csv into /workspace/outputs/chart.png"
orca sessions artifacts <session-id> --json             # what the agent saved under /workspace/outputs
orca sessions artifacts download <session-id> --all -o results
orca sessions sleep <session-id>                        # done for now: saves /workspace, stops machine time; the next message wakes it
orca sessions delete <session-id> --yes                 # stops the sandbox; its artifacts go with it
```

`--file <path>[:<dest>]` uploads the file and stages it at `/workspace/<its name>` (or `dest`); it implies `--sandbox` and works with `--session` on a session that has one. Only files saved under `/workspace/outputs` come back as artifacts, when the turn completes.

Copy one of Orca's kits. Kits are published by Orca; no organization makes or publishes its own:

```bash
orca kits show <link-or-public-id>           # prints what the kit holds: what it runs, reaches and spends, every agent, skill and template in full
orca kits copy <link-or-public-id> --yes     # only after the person has read that and said yes
```

Show the person what `orca kits show` prints, and run `orca kits copy <link> --yes` only after their yes. The copy is pinned to the version it reviews: if the kit changed in between, it copies nothing and prints the new review, so show that and ask again.

Account status (every figure is the server's, in micro-USD; never recompute costs):

```bash
orca billing wallet --json                   # balance, plan, packs on sale
orca usage --json                            # cost per meter over the last 30 days
orca usage --group-by agent --json           # group_costs: each agent's cost across every meter
```

A call's money is on its `model_calls` row and a search's on its `web_searches` row; token rows are at cost 0. Read a model's, session's or agent's cost from `group_costs`, never from the `model_tokens` groups. In `orca usage events`, `charged_on` says where a row's money is (`call`, `search`, or `late`); `--charged` lists only the rows with a cost. A call whose cost was not reported when it ended (cancelled, cut short, its session deleted mid-reply) is charged later from OpenRouter's record of it, on one `late_charges` row whose `charge_for` names the row it charges (`<attempt>:call` or `<attempt>:search`); its own rows show `charged_on: "late"`. A late charge can take the balance below the minimum or below zero; `orca billing wallet` then shows the negative balance, and paid work resumes when credit brings it back to the minimum.

Buying credit or a plan (`orca billing buy pro|max|pack:<cents>`) returns a checkout link: give it to the user to open; never try to pay.

## MCP server (richer sessions)

For extended work, register Orca's MCP server once:

```bash
claude mcp add orca -- orca mcp serve
```

It exposes one tool per CLI action: whoami and keys, agents and `list_models`, sessions, `chat` (sends a message and waits for the reply, returning the session id; it and `create_session` take `files` to stage into the sandbox), `sleep_session` (puts a session's sandbox to sleep now; refused while a turn runs), `list_artifacts` and `download_artifact`, skills, vaults, files, usage and billing, and kits (`show_kit` returns a kit's review; call `copy_kit` with the `version` it returned only after the person says yes).

To ask a named agent something, call `chat` with `agent` set to that name and nothing before it: no `list_agents`, no `get_agent`. A new session's `sandbox`, `template` and `vaults` go on that same first `chat` (or on `create_session`). List tools return summaries (an agent's id, name, model and tool types, never its instructions); `get_agent` and `get_session` return one item in full. Every result is valid JSON: a page too large for one result comes back shorter with `hasMore: true` and `lastId` to pass as `after`, and a long string cut to fit ends in `[shortened from N characters]`.

### Kits that need a vault

Some kits only work with a vault: it holds the credential for their MCP server. The kit's README and docs page name it, for example seo-helper: `vaults: ["dataforseo"]`.

- Pass the vault on the first `chat`, with the agent, by name: `chat({agent: "seo-helper", vaults: ["dataforseo"], message: "..."})`. Later turns pass only `session` and `message`; a session keeps its vaults. Add `template`, `sandbox` or `files` only when the kit's README names them.
- The credential is the user's step, in their own terminal. Never ask the user for a password or token in the chat, and never pass one to `add_credential` yourself: anything in a tool call sits in your context. Give them the commands, which read the secret from a hidden prompt: `orca vaults create dataforseo`, then `orca vaults credentials add dataforseo --name dataforseo --server https://mcp.dataforseo.com/mcp --basic --login <their login>`.
- A first `chat` that fails with "No credential in the attached vaults for <url>" created no session: either `vaults` was left off the call, or the vault holds no credential for that server yet. Check the call first; otherwise the user's step is not done: relay the message and the commands, and send the message again once they say it is.

### A research agent returns a brief

Some kits research and hand back a brief, and you do the writing in the repo. seo-helper is one: topics for the next post, then an SEO brief for the one the user picks. The same steps fit any research kit (a competitor scan, a docs audit).

1. Send the repo's context in the message, after the user's words: today's date (the agent has no clock), the posts that exist and the topics picked before (title, URL, target keyword), and the essentials of the kit's site brief (seo-helper keeps it at `.orca/seo-helper/site-brief.md`). At most 8 KB; for a bigger repo, send the newest first. Never repo files, drafts or secrets.
2. Check any JSON block the reply carries against what you sent, before the user sees it: every number against the thresholds you sent, every topic against the repo, which you can read in full. Drop what fails and say which and why ("Dropped #3: difficulty 67 is over your 35"). If the block is missing or does not parse, ask once: "Send the JSON block again, nothing else"; then show the reply and say the check could not run.
3. Ask for a brief by the keyword exactly as it appears in the JSON block, never by number alone (seo-helper: `Brief: what is mcp`). Ask for more topics the same way, `More like <keyword>` (seo-helper: `More like what is an mcp server`); a number alone ("more like #2") gets a question back and no research.
4. Save the brief in the repo, as it came (seo-helper: `.orca/seo-helper/briefs/<slug>.md`).
5. Measure the length yourself. The brief lists the top 3 competitor URLs and no word counts: fetch those pages and count their words before writing, and keep the post's length in that range unless the repo's rules say otherwise.
6. Write with the repo's own rules (its `CLAUDE.md` or `AGENTS.md`, its README, its existing files), never the agent's: the brief says what to cover, not how to write it.
7. Check the result against the brief: run its "Check before commit" list on your file and fix what fails.
8. Commit with your own git: a branch and a commit, or a pull request, with the brief beside the work. Orca never needs a GitHub token.
9. Delete the session: `delete_session({id})`.

### When `chat` returns `done: false`

The turn outlasted `timeoutSeconds` (at most 600) and is still running in Orca; nothing is lost. Tell the user it is still working, then call `get_session({id})` about every 30 seconds until its `status` is `idle`, and read the reply with `list_session_items({id, limit: 5})` (messages keep their whole text). Never send the message again: that starts a second turn.

## References

- `references/cli-cheatsheet.md`: the full command surface with flags.
- `references/api-cookbook.md`: the raw API (the `/v1` Agents API through any OpenAI client, and the `/api` routes with curl) for anything beyond the CLI.

## Troubleshooting

- Exit 3 or 401: run `orca login` again (or check `ORCA_API_KEY`).
- "Out of Orca credit" (HTTP 429, or a turn that fails with `usage_limit_exceeded` and `param` `orca_credit`): paid work is paused because the balance is under the plan's minimum; `orca billing wallet --json` shows `paid_work_paused` and `min_balance_micro_usd`. Add credit, then continue the session, or switch this session to a model on your own key: `POST /api/sessions/{id}/model {"model": "..."}` (in a terminal, `orca chat` offers it).
- `param` `provider_quota`: your own provider account is out of quota. Top up there, or switch the session to Orca credit the same way.
- 400 on `model` when saving: the name must say who pays (`orca/openrouter/<OpenRouter id>` for Orca credit, `<provider>/<id>` with your own key), the provider must list it, and an own key must be saved. `orca models --json` lists every name you can use.
- "does not support device login": the API URL does not point at an Orca server; check `orca auth status`, or use `orca login --with-token <key>` with a key minted in the dashboard.
- Anything else: `orca doctor --json` names the failing check and the fix.
