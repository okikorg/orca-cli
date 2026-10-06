# Orca API cookbook

For anything the CLI or the MCP tools do not cover, use the raw API. Auth is one header everywhere: `Authorization: Bearer <orca_sk_key>`.

The server has two surfaces:

- `/v1`: the OpenAI-compatible Agents API (agents, sessions, skills, vaults, files, environment templates). Use the official `openai` package (TypeScript or Python) with `baseURL` set to `https://api.orcapods.ai/v1` and the Orca key as the API key.
- `/api`: Orca's own routes (whoami, keys, usage, billing, kits, publishing, device login).

## /v1 through the openai package

```ts
import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.ORCA_API_KEY, baseURL: 'https://api.orcapods.ai/v1' })
const agent = await client.beta.agents.create({ model: 'openai/gpt-5', name: 'support', instructions: 'Be brief.' })
const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' } })
for await (const event of client.beta.agents.sessions.stream(session.id, { input: 'Hello' })) {
  if (event.type === 'agent.session.turn.output_text.delta') process.stdout.write(event.delta)
}
```

Environment templates (a hosted sandbox's files and skills) are `client.beta.agents.environments.templates`; pass a template's id as `environment: { type: 'openai_hosted', environment_template_id }`.

## /api with curl

```bash
K="Authorization: Bearer $ORCA_API_KEY"
B=https://api.orcapods.ai

curl -s -H "$K" $B/api/whoami                                  # tenant, actor, role
curl -s -H "$K" "$B/api/keys?limit=20"                         # API keys (no secrets)
curl -s -H "$K" "$B/api/usage?group_by=model"                  # cost per meter and model, last 30 days
curl -s -H "$K" "$B/api/usage/events?limit=20&meter=model_tokens"
curl -s -H "$K" $B/api/billing/wallet                          # balance and plan
curl -s -H "$K" $B/api/kits                                    # this organization's kits
curl -s $B/api/public/kits/kit-xxxxxxxxxxxxxxxxx               # a published kit, no auth
curl -s -H "$K" -X POST $B/api/kits/kit-xxxxxxxxxxxxxxxxx/copy \
  -H 'Content-Type: application/json' -d '{"assets":[{"key":"agent-1","name":"support"}]}'
curl -s -H "$K" $B/api/agents/<agent_id>/published-keys
curl -s -H "$K" -X POST $B/api/agents/<agent_id>/publish \
  -H 'Content-Type: application/json' -d '{"label":"website","environment_template_id":"envtmpl_...","vault_ids":["vault_..."]}'
```

## Notes

- Money is micro-USD (`cost_micro_usd`, `balance_micro_usd`) and computed by the server; format it, never recompute it.
- Lists use cursors: `?limit=` (1 to 100) and `?after=<last id>`, with `has_more` in the body.
- Errors are `{"error": {"message", "type", "param", "code"}}`; rate limits and out-of-credit answer 429 with a `code` of `rate_limit_exceeded` or `insufficient_quota`.
- A key carries the role of whoever minted it; a published agent's key reaches only that agent's sessions. Its session create must name the environment (and, optionally, the vaults) its publisher fixed: `GET /api/whoami` with the key returns them as `environment` and `vault_ids`, and anything else is refused with the values to send.
