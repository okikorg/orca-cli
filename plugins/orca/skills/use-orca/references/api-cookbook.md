# Orca API cookbook

For anything the CLI or the curated MCP tools do not cover, use the raw API. The full schema is machine-readable and unauthenticated:

- https://api.orcapods.ai/api/openapi.yaml (spec)
- https://api.orcapods.ai/api/docs (interactive viewer)
- The `orca://openapi` MCP resource (same spec, no network hop needed)

Auth is one header everywhere: `Authorization: Bearer <ao_key>`.

## Via the MCP api_request tool

```json
{ "method": "GET", "path": "/api/pools" }
{ "method": "POST", "path": "/api/runs", "body": { "profile": "support", "prompt": "triage", "title": "triage" } }
{ "method": "GET", "path": "/api/stats/summary", "query": { "window": "7d" } }
{ "method": "PUT", "path": "/api/spend-cap", "body": { "monthlyCapCents": 5000 } }
```

Rules: `path` must start with `/api/`; responses are truncated at about 50KB, so page with `query: {"limit": "..."}` where the endpoint supports it.

## Via curl

```bash
K="Authorization: Bearer $ORCA_API_KEY"
B=https://api.orcapods.ai

curl -s -H "$K" $B/api/whoami                          # who am I
curl -s -H "$K" $B/api/profiles                        # agents
curl -s -H "$K" -X POST $B/api/runs \
  -d '{"profile":"support","prompt":"triage the inbox","title":"triage"}'
curl -s -H "$K" $B/api/runs/<id>                       # status + buffered events
curl -s -N -H "$K" $B/api/runs/<id>/stream             # SSE until terminal
curl -s -H "$K" $B/api/runs/<id>/events                # NDJSON replay
curl -s -H "$K" $B/api/skills                          # skill catalog
curl -s -H "$K" $B/api/sessions                        # sessions
curl -s -H "$K" $B/api/pools                           # agent pools
curl -s -H "$K" $B/api/workflows                       # workflow definitions
curl -s -H "$K" $B/api/billing/wallet                  # credits
curl -s -H "$K" $B/api/usage                           # metered usage
```

## Resource groups in the spec

Profiles (agents, revisions, publish, keys, memories, metrics, usage), Runs (create, get, events, stream, terminate), Sessions, Pools, Workflows (definitions, runs, schedules), Skills (CRUD, import, resources), Storage, Memory bank, Secrets, MCP-server catalog, Connected apps, Capabilities, Stats, Usage, Billing, Spend cap, API keys, Topology, Publishing.

## Notes

- List endpoints are paginated: `?limit=` and `?offset=`, with totals in the `X-Total-Count` header.
- POST /api/runs returns 202 with `{runId, sessionId}`; the run executes asynchronously.
- Keys are role-inheriting and have no scopes: treat an admin key as admin everywhere.
