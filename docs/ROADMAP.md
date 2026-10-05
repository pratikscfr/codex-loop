# Roadmap: from v0.1 to a platform

This document is deliberately explicit about what exists today and what is a plan.

## Where v0.1 stands

| Area | Status |
|---|---|
| Deterministic control engine (20 controls, repo-agnostic, tri-state results, time-boxed exceptions, audit → warn → enforce rollout) | **Shipped**, covered by automated tests, and run against real public repositories ([COMPAT.md](COMPAT.md)) |
| Four surfaces on one engine: CLI, GitHub Action, hosted Worker, MCP server | **Shipped** |
| Per-repo stateful agent (Durable Object) with memory, durable analysis Workflow, grounded chat, cited AI advisory | **Shipped** |
| Agent context generation (`AGENTS.md`) with a CI drift gate (`context --check`) | **Shipped** |
| Public-signal PR footprint (agent / AI-signal / automation / no-signal) | **Shipped**, with explicit lower-bound caveats |
| Eval harness for agent configurations | **Designed below, not built** |
| Org-wide dashboards, OAuth-protected MCP, GitHub App checks, autofix PRs | **Not built** |

## The idea this is building toward

Engineering standards usually live in three disconnected places: a wiki page humans skim, CI checks that enforce a subset, and (lately) prompt files that coding agents may or may not read. They drift apart, and nobody can say whether any of them is working.

The thesis: **one versioned control is enforced in CI, taught to agents as context, and measured.** v0.1 implements the first two and a lightweight version of the third. The missing piece is the one that turns measurement into learning, and it is the part that would justify a team working on it for a quarter.

### Context is code, so it gets CI: the agent-config eval gate

Today a change to `AGENTS.md`, an MCP tool description, a model setting or a skill file ships on vibes. The same change to application code would be unthinkable without tests. The eval gate closes that gap.

**Task mining (per repository, no setup).** From the repo's own history, select merged pull requests that change source *and* tests, where the new tests fail on the base commit and pass on the head commit (fail-to-pass). Each becomes a task:

- *Prompt*: derived from the PR title/description with the solution stripped, rewritten by a model only to remove leakage.
- *Environment*: a container at the base commit using the repo's own install/test commands (declared in `.codex-loop.yml`, auto-detected otherwise), with future git history removed.
- *Hygiene*: run base and head three times to discard flaky tests; cap diff size; exclude generated and vendored paths.

Small repositories simply yield fewer tasks and wider confidence intervals, which the report states. Synthetic tasks (bug injection) are a lower-trust fallback and are labelled as such.

**Execution.** One sandbox per (task, configuration, seed) through Cloudflare's Sandbox SDK / Containers behind an executor interface (a GitHub Actions executor is the fallback while the Sandbox scheduling policy is in public beta). The agent harness is pluggable; models are routed through AI Gateway with per-run token budgets.

**Graders.** All deterministic: (1) the hidden tests pass, (2) the resulting diff is checked by the **same control engine as the PR check** (a compliance score per standard), (3) diff size / scope sanity, (4) cost and wall-clock. An LLM judge, if used at all, is auxiliary and calibrated against human labels.

**Statistics.** Paired comparison of baseline vs candidate on identical tasks with several seeds; bootstrap confidence intervals; a minimum-detectable-effect readout. The gate *refuses to declare a winner* when the sample cannot support one. "No detectable difference; need about 60 tasks" is a valid and useful output.

**The gate.** A pull request that touches agent context, MCP tool definitions, model or harness config triggers a budget-capped run on a sampled task set and comments the paired result. It becomes a required check only in `enforce` mode, exactly like any other control.

**Calibration (what makes it a platform, not a demo).** Compare offline deltas with production outcomes from the PR footprint: violation density, revert rate and review latency of agent-authored PRs by configuration version. If offline evals do not predict production, the evals are wrong, and the system says so.

> Novelty is **not** claimed. SWE-bench-style task construction exists in research. The intended contribution is the combination: a per-repo eval gate for agent configuration, graded by the organization's own standards, calibrated against production telemetry.

## Quarter plan (team of three, one lead)

| Weeks | Outcome | Exit criteria |
|---|---|---|
| 1–3 | **Pilot in audit mode** on 3 repositories chosen with their owners; map the real engineering standards onto the control schema; replace or extend the 20 generic controls | Every pilot repo has a report; false-positive rate per control measured from owner feedback; noisy controls demoted |
| 4–6 | **Enforce + instruct:** promote the trusted controls to `warn`/`enforce` in CI via the Action; serve the MCP server to internal coding agents behind SSO; generate and gate `AGENTS.md` | Agent context covered by the drift gate on pilot repos; MCP usage visible in logs |
| 7–9 | **Eval gate v1** on two pilot repos (task miner, executor, graders, paired report, PR comment) | Gate runs within a fixed budget per PR; CIs reported; at least one real configuration change evaluated |
| 10–12 | **Calibration and scale-out:** compare offline deltas with production footprint; exceptions workflow with approver notification; onboard the next cohort | A written calibration result (positive or negative); cohort 2 onboarded without engineer help |

Proposed success metrics (targets to be set after the pilot baseline, not before): time-to-first-value per repo; share of agent-config changes covered by the eval gate; violation rate of agent-authored vs human PRs; rank correlation between offline evals and production outcomes.

## Known gaps and honest risks

- **Per-repo environment setup is the hard part of the eval harness.** Dependency installs, services and flaky tests dominate the cost. The plan starts with repositories that have clean test commands.
- **Controls are generic.** They are real, cited standards, but they are not a specific organization's Codex. Mapping a real Codex onto the schema is week 1–3 work.
- **Authorship detection from public signals undercuts AI usage.** Internally, agent harness telemetry is a far better source; the footprint view is deliberately labelled a lower bound.
- **The hosted service's MCP endpoint is unauthenticated and read-only**, which is acceptable only for public-repository data. An internal deployment puts SSO (Cloudflare Access + OAuth) in front.
- **Secret scanning is bounded** by the file-read budget in hosted mode and reports `unknown` when coverage is low; the CLI and Action scan everything.
