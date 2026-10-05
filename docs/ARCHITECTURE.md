# Architecture

## One engine, four surfaces

```
packages/core  ── pure TypeScript, no Node imports in the main entry (runs in Workers, Node, tests)
   Snapshot ─ paths + lazy read()          implemented by: local disk · GitHub API · in-memory
   profileRepo ─ languages, ecosystems, monorepo?, commands        (decides what applies)
   CONTROLS ─ 20 pure checks  →  pass | fail | unknown  (n/a from the profile)
   analyze() ─ profile → config → controls → exceptions → Report   (never throws on bad repos/config)
   renderers ─ markdown · text · GitHub annotations · AGENTS.md block
   footprint ─ PR classification from public signals

packages/cli    `codex-loop check | remote | context | controls | explain`
action/         composite of annotations + step summary + sticky PR comment + context drift gate
apps/worker     Cloudflare Worker (below)
```

The `Report` is plain JSON (`packages/core/src/types.ts`): every surface renders the same object.

## The hosted service

```
 browser / curl / MCP client
        │
        ▼
 Worker fetch handler ── validate input · cheap per-client read limit FIRST · body limits · security headers
        │
        ├─ POST /api/analyze ─► cache hit (≤15 min)? return it
        │                        otherwise create a Workflow instance (deduplicated per repo)
        │                                   │
        │                        AnalyzeRepoWorkflow
        │                          1. analyze   GitHub API (3 calls) + ≤40 raw reads → Report; retries with backoff
        │                                       (rate limit > 120 s or a permanent error is not retried)
        │                          2. advisory  optional Workers AI summary; schema- and citation-validated; never fails the run
        │                          3. persist   RepoAgent.saveReport
        │
        ├─ GET  /api/analysis/:id · /api/report/:owner/:repo · /api/agents-md/:owner/:repo
        ├─ POST /api/chat/:owner/:repo ─► streamText (Workers AI) with read-only tools over the stored report (needs X-Session-Id)
        └─ /mcp ─► MCP server (Streamable HTTP): analyze_repository · get_agent_context · explain_control · list_controls

 RepoAgent (Durable Object, one per lowercase owner/repo, SQLite)
     latest report · bounded history of past runs · chat memory scoped per browser session (30 messages, 20 sessions)
     a scheduled refresh that only runs for recently viewed repos and cancels itself when they go quiet
 RateLimiter (Durable Object)   per-client and global counters
```

Why these primitives:

- **Workflow** for the analysis because it is a multi-step, retry-worthy sequence with an external dependency that rate-limits. Step boundaries give durable progress and backoff without hand-rolled state.
- **Durable Object per repo** because the state is naturally keyed by repository: single-writer consistency for report history and chat, no cross-tenant data, and a natural place for the refresh schedule. Chat memory is scoped by a random per-browser session id so visitors can neither read nor influence each other's conversations.
- **Workers AI** for chat and the advisory, behind tools that only read the stored report. The model has no network, no write path and no secrets.
- **No queue.** Nothing here needs fan-out or buffering yet; the Workflow is the unit of work. (Queues would be added for webhook ingestion once a GitHub App drives analyses.)

## Analysis budget

A hosted analysis costs 3 GitHub API calls (repository, commit, tree) plus at most 40 raw file reads, plus one API call for the PR footprint: about 44 subrequests, under the 50-per-invocation limit of the Workers Free plan. `MAX_FILE_READS` can be raised on a paid plan. Structural controls run first; the content-based secret scan (CDX-032) uses what is left and reports `unknown` if it covered under half of the candidate files.

Measured, same repository through both paths ([COMPAT.md](COMPAT.md), `npm run compat:diff`): statuses are identical for 3 of 4 repositories; for the fourth (gin) the only difference is CDX-032, `pass` from a full local scan vs `unknown` from the hosted path, which read 36 of 130 files. That is the intended behavior: the hosted path admits what it did not look at instead of guessing.

## Failure semantics

| Situation | Behavior |
|---|---|
| A file is missing or binary | Treated as absent; controls decide (`fail` or `n/a`) |
| A check cannot decide (unparseable config, unresolved base image, exhausted budget) | `unknown` with the reason; never fails CI |
| A check throws | `unknown` with the message; the rest of the run completes |
| GitHub rate limit or network error during the run | Aborts the run with a typed, retryable error; nothing is stored |
| Private, missing, empty or legally blocked repo | Typed permanent error → clear HTTP status and message |
| Model unavailable or returns invalid/uncited output | Advisory omitted; the deterministic report is unaffected; chat returns 503 |

## Local and CI use

The CLI and Action read the working tree through `git ls-files` (so ignored files are excluded) and never follow symlinks out of the repository. There is no read budget locally, so the secret scan always covers every candidate file. `context --check` makes the generated `AGENTS.md` block a build artifact: it is deterministic, contains no timestamps or file counts, and never describes its own existence, so `--write` followed by `--check` is a fixed point (there is a regression test for exactly that).
