# codex-loop

**Write an engineering standard once. Enforce it in CI, teach it to coding agents, and see whether it is working.**

Engineering standards usually live in three disconnected places: a wiki page people skim, a few CI checks, and (lately) prompt files that coding agents may or may not read. They drift apart, and nobody can say which of them is doing any good. As agents raise the volume of changes, the bottleneck moves from writing code to reviewing and validating it, which is exactly where unenforced standards hurt.

codex-loop keeps one catalog of **deterministic controls** and exposes it on every surface where work happens:

| Surface | What it does |
|---|---|
| **CLI** | `codex-loop check` any local repo, or `codex-loop remote owner/repo` any public GitHub repo, with no clone and no install in the target |
| **GitHub Action** | Annotates pull requests, posts one updating summary comment, fails the build on `enforce`-mode controls, and gates `AGENTS.md` drift |
| **Agent context** | Generates a token-budgeted `AGENTS.md` (real build/test commands + only the rules that apply to *this* repo) and keeps it in sync in CI |
| **Hosted service (Cloudflare)** | Paste a repo URL and get a report; chat with a per-repo agent that remembers the conversation; a cited AI advisory; a remote **MCP server** so coding agents can look up the standards and analyze repos |

> **The gate is deterministic. The model is advisory.** Pass/fail never comes from an LLM. The model can only summarise and prioritise findings, every item must cite a control that is actually failing, and anything else is dropped.

## Try it

**Any public repo, no setup** (needs Node 20+):

```bash
git clone https://github.com/pratikscfr/codex-loop && cd codex-loop && npm ci && npm run build
node packages/cli/dist/cli.js remote cloudflare/agents-starter --footprint
```

**A local repo:**

```bash
node packages/cli/dist/cli.js check /path/to/repo            # exit 1 if an enforce-mode control fails
node packages/cli/dist/cli.js context /path/to/repo --write  # create/refresh the AGENTS.md block
node packages/cli/dist/cli.js context /path/to/repo --check  # CI gate: exit 1 if that block is stale
node packages/cli/dist/cli.js explain CDX-011                # why a control exists and how to fix it
```

**In any repository's CI:**

```yaml
permissions:
  contents: read
  pull-requests: write   # only needed for `comment: true`
jobs:
  standards:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pratikscfr/codex-loop/action@COMMIT_SHA   # pin to a full commit SHA, as control CDX-011 asks of everyone
        with:
          fail-on: enforce        # enforce | warn | never
          comment: "true"
          check-context: "true"   # fail if AGENTS.md is out of date
```

## What it checks

20 controls across hygiene, CI, supply chain, secrets, containers, Cloudflare Workers config, code quality and agent readiness, documented in [docs/CONTROLS.md](docs/CONTROLS.md) (generated from the code, with a test that fails if the two drift). Examples: GitHub Actions pinned to commit SHAs, least-privilege workflow permissions, lockfiles committed, no credential files tracked, high-confidence secret scan, Docker base images pinned and non-root, Wrangler `compatibility_date` current, no literal secrets in Wrangler `vars`, TypeScript `strict`, tests exist.

Design properties that make it safe to point at arbitrary repositories:

- **Tri-state results.** `pass`, `fail`, `n/a` (does not apply to this repo) or `unknown` (could not decide). `unknown` never fails a build and partial information is never reported as a pass.
- **Rollout, not a wall of red.** Each control starts in `audit`, `warn` or `enforce`; repos override per control in `.codex-loop.yml`. Exceptions need a reason and an expiry (max one year); an expired exception re-enforces the control and says so.
- **Transient failures are retried, not recorded.** A GitHub rate limit or network error aborts the run (the hosted Workflow retries with backoff) instead of becoming a report full of `unknown`.
- **Secrets are never echoed.** Findings show file, line and a four-character prefix.
- **Repo content is untrusted.** Everything derived from a repository is escaped before it reaches markdown or the UI, and is fenced as data before it reaches a model.

## How it fits together

```
                    ┌──────────────── packages/core ────────────────┐
  local disk ──┐    │  Snapshot (paths + lazy read)                 │
  GitHub API ──┼──► │  profile → applicable controls → tri-state    │ ──► Report (plain JSON)
  in-memory ───┘    │  config: modes, time-boxed exceptions         │        │
                    └───────────────────────────────────────────────┘        │
                                                                              ▼
        ┌────────────┬───────────────┬─────────────────────────────────────────────────────┐
        │ CLI        │ GitHub Action │ Cloudflare Worker                                   │
        │ text/json/ │ annotations,  │  POST /api/analyze → Workflow (retries, dedupe)      │
        │ markdown   │ summary,      │  → RepoAgent Durable Object (memory, history)       │
        │            │ PR comment    │  → chat (Workers AI) · AI advisory · MCP server     │
        └────────────┴───────────────┴─────────────────────────────────────────────────────┘
```

Deeper notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) · [docs/ROADMAP.md](docs/ROADMAP.md)

## Does it actually work?

**Verified, and how:**

- `npm test` (Node's built-in runner, no bundler or native bindings): every control's pass and fail paths, exceptions and config errors, the renderers (including markup-injection attempts), the CLI exit-code contract, local-disk safety (symlinks), the GitHub adapter against a mocked API (rate limits, private/empty repos, binary and oversized files, the subrequest budget, token handling), and the Worker's pure logic (validation, rate limits, citation checks, chat sessions, refresh window).
- [docs/COMPAT.md](docs/COMPAT.md): the hosted code path run against real public repositories (JS, Go, Python, Rust, a 33,000-file monorepo, a nearly empty repo, a nonexistent one): no crashes. The same repos through the local-disk path give identical results, except where the hosted file-read budget legitimately turns the secret scan into `unknown` (see [ARCHITECTURE](docs/ARCHITECTURE.md#analysis-budget)).
- The CLI bundle and the Action bundle were run as built artifacts, and the Action was driven the way the runner drives it (annotations, step summary, outputs, path-escape rejection, `fail-on`).
- A clean-room install (`npm ci` on a copy with no `node_modules`), typecheck, tests and build all pass, and the committed Action bundle is byte-identical to a fresh build.
- The Worker was run locally with `wrangler dev` against a mock GitHub (`scripts/mock-github.mjs`) and exercised black-box by `scripts/smoke.mjs`: validation errors, cross-origin and oversize rejection, the full Workflow → Durable Object → report → `AGENTS.md` path, session-private chat, the MCP handshake and tool list, and the MCP batch rate-limit guard. All planted problems in the mock repo were found at the right file and line and no secret value appeared in any payload. `wrangler deploy --dry-run` succeeds (611 KiB gzipped).
- An independent review of the Worker found 12 issues (two high: an MCP rate-limit bypass via JSON-RPC batches, and a refresh that renewed its own schedule forever). All were fixed, each with a test.

**Not verified (please read before relying on it):**

- **Workers AI calls** (chat answers and the advisory) have not been run against the real model. The prompt construction, citation validation, streaming and the 503 fallback are unit-tested only.
- **A production deployment** has not been made, so behavior on Cloudflare's edge, real `raw.githubusercontent.com` reads from a Worker (blocked on the dev machine by a TLS-intercepting proxy), the scheduled refresh alarm, and a real MCP SDK client session are untested. The GitHub reads themselves are exercised through the CLI and the compatibility run.
- **The GitHub Action has not run on a real runner yet.** It was simulated locally; the first push will run the repo's CI and dogfood job.
- Several Worker tests are source-order guards (for example "the read limiter runs before the Durable Object is touched") rather than runtime tests.
- Controls are generic, well-known practices, not any organization's internal standard. The PR footprint uses public signals only and is a lower bound. Hosted secret scanning is bounded by a file-read budget. The eval harness in the roadmap is a design, not shipped code.

## Development

```bash
npm ci
npm run typecheck && npm test
npm run build          # bundles the CLI and the Action; action/dist is committed on purpose
npm run docs           # regenerate docs/CONTROLS.md after changing a control
npm run compat         # analyze real public repos through the hosted code path
npm run compat:diff    # compare local-disk vs GitHub-API results for the same repos
node scripts/smoke.mjs <base-url> [owner/repo]   # black-box test of a running Worker (see apps/worker/README.md)
```

MIT licensed. See [AGENTS.md](AGENTS.md) for conventions, which the generated block in that file applies to this repo too.
