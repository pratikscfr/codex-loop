# Architecture decisions

Short records of the decisions that shape the system, with the trade-off accepted.

## 1. The gate is deterministic; the language model is advisory only

Pass/fail comes from pure functions over repository contents. A model never decides a verdict. It can summarise and prioritise the deterministic findings, and every item it produces must cite a control that is actually failing in the report. Uncited or unknown IDs are dropped, and if nothing valid remains the advisory is omitted.

*Why:* blocking a merge on a non-deterministic answer destroys trust in the platform within a week. It also makes results untestable.
*Cost:* the system cannot flag things no rule describes. That is acceptable: rules are cheap to add and reviewable.

## 2. One engine, many surfaces, through a `Snapshot` abstraction

A `Snapshot` is a list of paths plus a lazy `read(path)`. Local disk, the GitHub API and an in-memory map all implement it, so the exact same controls run in the CLI, the Action, the Worker, and the MCP server, and in tests. The Worker-safe entry point never imports Node modules; the disk adapter lives in a separate `@codex-loop/core/node` export.

*Why:* "the check in CI says something different from the hosted report" is a credibility killer.
*Cost:* controls can only use what a snapshot offers (paths and text). Anything needing a build or network is out of scope for this layer (and belongs in the eval harness).

## 3. Results are tri-state, and partial information is never a pass

`unknown` is a first-class result. A check that cannot decide (unreadable config, missing base image, budget exhausted, low scan coverage) reports `unknown` with the reason, and `unknown` never fails a build. Separately, **transient infrastructure failures (GitHub rate limits, network errors) abort the run** instead of being downgraded to `unknown`, so a flaky fetch can never be stored as a finished report. The hosted Workflow retries them with backoff.

*Why:* false confidence and false alarms are both expensive. The honest answer is sometimes "I could not tell."

## 4. Standards roll out as `audit → warn → enforce`, per repository, in git

Each control has a default mode; a repository overrides it in `.codex-loop.yml`. Exceptions require a reason and an expiry date no more than a year out; an expired exception re-enforces the control and says why. All of it is reviewable in a pull request.

*Why:* standards that arrive as a surprise wall of red get disabled. Progressive rollout plus expiring exceptions is how a platform team stays trusted.

## 5. A bounded file-read budget in the hosted service

A hosted analysis makes 3 API calls plus at most 40 raw file reads, which fits inside Cloudflare Workers' 50-subrequest limit for the free plan. Structural controls run first; the content-based secret scan uses the remaining budget and reports `unknown` when it covered under half of the candidate files. The CLI and Action have no budget and scan everything.

*Why:* predictable cost and latency on arbitrary repositories, and an explicit boundary instead of a silent timeout.

## 6. Public repositories only; the service token is never a way to read private ones

The hosted analyzer refuses private repositories even when its token could read them, sends the token only to `api.github.com`, and treats all repository content as untrusted input.

## 7. Tests run on Node's built-in runner

The test suite uses `node:test` through `tsx` with a tiny `describe/it/expect` shim. There is no bundler or native binding between a contributor and a green test run. (This replaced an initial choice of vitest, whose native rolldown binding failed to install on the development machine.)
