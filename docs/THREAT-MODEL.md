# Threat model

Scope: the hosted Worker (anonymous users analyzing **public** GitHub repositories), the CLI/Action (run by a maintainer on their own checkout), and the MCP endpoint. The defining property is that **repository contents are attacker-controlled input**, and the hosted service holds a GitHub token and a Workers AI binding that must not be spendable by strangers.

## Assets

| Asset | Why it matters |
|---|---|
| Service `GITHUB_TOKEN` (optional secret) | Could read private repos or exhaust a shared quota |
| GitHub API quota | Shared by every user; exhausting it is a denial of service |
| Workers AI / Workflow / Durable Object spend | Unauthenticated endpoints that trigger them are a cost-abuse surface |
| Integrity of stored reports | A wrong report presented as authoritative misleads users and agents |
| Users' browsers | The UI renders strings that come from arbitrary repositories |

## Trust boundaries

Untrusted: repository file names and contents, PR text, `.codex-loop.yml`, every request field, every header. Trusted: the Worker code, its bindings, and the control catalog.

## Threats and mitigations

| # | Threat | Mitigation | Where |
|---|---|---|---|
| 1 | **SSRF / arbitrary fetch** via owner, repo or ref | Names and refs validated against strict patterns; the only fetched hosts are `api.github.com` and `raw.githubusercontent.com`, hard-coded. Refs are not accepted by the hosted API at all (CLI only) | `core/github.ts`, `worker/lib/validate.ts` |
| 2 | **Token misuse**: reading a private repo with the service token | Private repos are rejected after one metadata call; the token is attached only to `api.github.com`, never to raw content; a revoked token falls back to anonymous | `core/github.ts` (tests) |
| 3 | **Secret disclosure** through findings | Matched values are never printed, only file, line and a 4-character prefix; logs and errors pass through a redactor | `core/controls/secrets.ts`, `worker/lib/errors.ts` |
| 4 | **XSS / markup injection** from file names, evidence, chat and advisory text | UI uses `textContent` only (no `innerHTML`, no markdown renderer); links are restricted to `https://github.com/` and in-page anchors; CSP `default-src 'none'; script-src 'self'; style-src 'self'`; markdown reports put repo-controlled names in code spans and escape the rest | `worker/public/*`, `core/format.ts` (tests) |
| 5 | **Prompt injection**: repo text steering the model | The advisory step has **no tools**; repo-derived text is sanitised and fenced as data; output is schema-validated and every item must cite a control that is *currently failing and not excepted*, otherwise it is dropped. Chat tools are read-only over the stored report, step-limited, and size-capped. The model can never change a verdict | `worker/lib/citations.ts`, `advisory-prompt.ts`, `chat.ts` |
| 6 | **Cost abuse / DoS**: many analyses, chats, MCP tool calls | Per-client and global limits; the MCP limiter charges per tool call (batches cannot bypass it); limits apply **before** per-repo Durable Objects are touched; IPv6 clients are keyed on their /64; 8 KB request bodies (32 KB for MCP); 15-minute cache; per-repo analysis dedupe | `worker/index.ts`, `routes.ts`, `lib/ratelimit.ts` |
| 7 | **Unbounded background spend** | The daily refresh only runs for repos a *user* viewed in the last 7 days; refreshes do not renew that window | `worker/repo-agent.ts` |
| 8 | **Report poisoning**: another user overwriting a repo's stored report | The hosted service analyzes only the default branch, so there is a single canonical report per repo | `worker/routes.ts` |
| 9 | **Cross-user leakage / planting** through shared chat history | Chat memory is scoped per browser session (random UUID) and never replayed to other sessions' prompts | `worker/repo-agent.ts` |
| 10 | **Local file disclosure** when checking a checkout | Symlinks are never followed; paths with `..` are rejected; the Action requires `path` to stay inside the workspace; `context --file` must stay inside the repo | `core/node.ts`, `action/src/index.ts`, `cli/main.ts` (tests) |
| 11 | **Hostile or pathological inputs**: huge or binary files, YAML alias bombs, malformed JSON/TOML, cyclic `extends` | Files over 256 KB (hosted) / 512 KB (local) and binary files are skipped; the YAML library's alias limit applies; every parser failure yields `unknown`, never a crash; `extends` chains have a depth limit and cycle detection | `core/snapshot.ts`, `controls/*` (tests) |
| 12 | **Supply chain**: compromised action or dependency | Actions in this repo are pinned to commit SHAs; lockfile covers every platform; Dependabot updates npm and Actions; the Action is a committed single-file bundle checked for staleness in CI | `.github/*`, `package-lock.json` |
| 13 | **Stale or forged verdict** stored as truth | GitHub rate limits and network errors abort a run instead of becoming `unknown` results; nothing is stored unless the run completed | `core/engine.ts` (test) |

## Known limitations

- **The MCP endpoint is public and unauthenticated.** It only exposes public-repository analysis and static control documentation, and is rate limited. An internal deployment should put SSO (Cloudflare Access + OAuth) in front of it.
- **Rate limiting is best-effort.** Keys are client IPs (IPv6 by /64) as seen by Cloudflare; a determined attacker with many networks is bounded only by the global limits, which also means a flood can degrade the service for everyone. Cloudflare's own rate limiting / WAF rules are the right next layer.
- **Durable Objects are created lazily per valid repository name** (including for a `GET` of a name nobody analyzed) and are not garbage-collected. Every such request first passes the per-client read limit (300/hour), which bounds growth but does not eliminate it; a registry or an idle-object cleanup alarm is the next step.
- **Secret scanning is pattern-based and bounded** in hosted mode. It will miss novel formats and will report `unknown` rather than `pass` when coverage is low. It ignores test, fixture, docs and example paths by design.
- **The AI advisory can still be wrong or awkwardly worded** even though every item cites a real failing control. It is labelled as a suggestion and is never part of a verdict.
- **No authentication means no per-user audit trail** in the hosted service.
