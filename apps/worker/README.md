# codex-loop Worker

The hosted service: a Cloudflare Worker with a static UI, a JSON API, a durable analysis Workflow, a per-repository agent (Durable Object with memory), grounded chat on Workers AI, and a public read-only MCP server. Architecture: [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md). Threats: [../../docs/THREAT-MODEL.md](../../docs/THREAT-MODEL.md).

## Run and deploy

```bash
# from the repository root, once
npm ci

# local development (chat and the AI advisory need a Cloudflare login; everything else works without one)
npm run dev -w @codex-loop/worker

# deploy
npx wrangler login                                   # opens a browser, once
npx wrangler secret put GITHUB_TOKEN                 # optional but strongly recommended, see below
npm run deploy -w @codex-loop/worker

# verify a deployment (or a local server) from the outside
node scripts/smoke.mjs https://codex-loop.<your-subdomain>.workers.dev octocat/Hello-World
```

`GITHUB_TOKEN` should be a **fine-grained personal access token with no repository permissions** (public read only is implicit). Without one, GitHub allows 60 API requests per hour per IP, and Cloudflare egress IPs are shared, so a public demo will hit `github_rate_limited` quickly. The token is only ever sent to `api.github.com`, and the service refuses private repositories even if the token could read them.

## Configuration

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | none | Raises the GitHub API limit (public data only) |
| `CHAT_MODEL` | var | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI model for chat and the advisory |
| `MAX_FILE_READS` | var | 40 | Cap on raw file reads per analysis. Keep ≤ 40 on the Workers **Free** plan (50 subrequests per invocation); raise it on a paid plan for deeper secret scanning |
| `MCP_ALLOWED_ORIGINS` | var | none | Comma-separated browser origins allowed to call `/mcp`. Unset means no CORS headers (MCP clients are not browsers) |
| `GITHUB_API_BASE`, `GITHUB_RAW_BASE` | var | GitHub | **Test seam only**, for pointing at `scripts/mock-github.mjs`. Never set in production |

## Behavior worth knowing

- **Default branch only.** `ref` is rejected by the hosted API (one canonical report per repository). Use the CLI for other refs: `codex-loop remote owner/repo --ref <branch|sha>`.
- **Limits** (per client, keyed on `cf-connecting-ip`, IPv6 by /64): 300 reads/hour, 20 analyses/hour, 60 chats/hour. Global ceilings apply on top. Requests over 8 KB (32 KB for MCP) are rejected.
- **Chat** needs an `X-Session-Id` header (the UI generates a random UUID per browser). History is private to that session: 30 messages per session, 20 sessions per repository, and other sessions' turns are never shown to the model. An interrupted answer is not stored.
- **MCP** (`/mcp`, Streamable HTTP) exposes `analyze_repository`, `get_agent_context`, `explain_control` and `list_controls`. It is public, unauthenticated and read-only; the only side effect is the 15-minute analysis cache. An analyzing call costs the same as `POST /api/analyze`, batches are charged per call, and a request may contain at most 3 analyzing calls.
- **Refresh.** A repository that a *user* has viewed in the last 7 days is re-analyzed daily; the refresh itself does not extend that window, so abandoned repositories stop costing anything.

## Tests and local end-to-end

```bash
npm test -w @codex-loop/worker          # unit tests of the pure logic (validation, limits, citations, sessions, ...)
```

To exercise the whole stack (Workflow, Durable Objects, report, agent context, chat sessions, MCP guards) **without** needing to reach GitHub, run the mock and point a local Worker at it:

```bash
node scripts/mock-github.mjs 8913 &
npx wrangler dev --local --port 8787 \
  --var GITHUB_API_BASE:http://127.0.0.1:8913/api --var GITHUB_RAW_BASE:http://127.0.0.1:8913/raw &
node scripts/smoke.mjs http://127.0.0.1:8787 mock/demo
```

What this verifies and what it does not is spelled out in the [root README](../../README.md#does-it-actually-work).
