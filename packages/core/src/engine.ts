import { loadConfig, type LoadedConfig } from "./config.ts";
import { CONTROLS, CONTROL_IDS } from "./controls/index.ts";
import { profileRepo } from "./profile.ts";
import { ReadBudgetExceeded } from "./snapshot.ts";
import type { Control, ControlException, ControlResult, Mode, Profile, RepoRef, Report, Severity, Snapshot, Summary } from "./types.ts";
import { todayUTC } from "./util.ts";

export const ENGINE_VERSION = "0.1.0";

export interface AnalyzeOptions {
  /** Pre-loaded config. If omitted the engine reads .codex-loop.yml from the snapshot. */
  config?: LoadedConfig;
  now?: Date;
  repo?: RepoRef;
  controls?: Control[];
}

const EMPTY_PROFILE: Profile = {
  languages: [],
  ecosystems: [],
  monorepo: false,
  hasDocker: false,
  hasWrangler: false,
  hasGithubActions: false,
  hasTypeScript: false,
  fileCount: 0,
  sizeBucket: "tiny",
  commands: {}
};

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

function pickException(exceptions: ControlException[], id: string, today: string): { active?: ControlException; expired?: ControlException } {
  const mine = exceptions.filter((e) => e.control === id).sort((a, b) => b.expires.localeCompare(a.expires));
  const active = mine.find((e) => e.expires >= today);
  return active ? { active } : { expired: mine[0] };
}

/**
 * Evaluate a snapshot against the control catalog. Never throws for bad repos or bad config:
 * a broken control yields `unknown`, a broken config falls back to defaults.
 */
export async function analyze(snapshot: Snapshot, opts: AnalyzeOptions = {}): Promise<Report> {
  const now = opts.now ?? new Date();
  const controls = opts.controls ?? CONTROLS;
  const ids = opts.controls ? new Set(controls.map((c) => c.id)) : CONTROL_IDS;

  let profile: Profile;
  try {
    profile = await profileRepo(snapshot);
  } catch {
    profile = { ...EMPTY_PROFILE, fileCount: snapshot.paths.length };
  }

  const loaded = opts.config ?? (await loadConfig(snapshot, ids, now));
  const { config } = loaded;
  const today = todayUTC(now);

  const results: ControlResult[] = [];
  for (const control of controls) {
    const entry = config.controls[control.id];
    const mode: Mode = entry?.mode ?? control.defaultMode ?? config.mode;
    const base = {
      id: control.id,
      title: control.title,
      category: control.category,
      severity: control.severity,
      mode,
      rationale: control.rationale,
      remediation: control.remediation
    };

    if (entry?.disabled) {
      results.push({ ...base, status: "na", evidence: [], note: "Disabled in .codex-loop.yml." });
      continue;
    }
    if (control.appliesTo && !control.appliesTo(profile)) {
      results.push({ ...base, status: "na", evidence: [] });
      continue;
    }

    let result: ControlResult;
    try {
      const outcome = await control.check({ snapshot, profile, now });
      result = { ...base, status: outcome.status, evidence: outcome.evidence };
    } catch (err) {
      // Transient infrastructure failures must abort the run (so callers can retry), not become "unknown".
      if (typeof err === "object" && err !== null && (err as { transient?: unknown }).transient === true) throw err;
      const note =
        err instanceof ReadBudgetExceeded
          ? "File read budget exhausted before this control could finish."
          : `Check failed to run: ${err instanceof Error ? err.message : String(err)}`;
      result = { ...base, status: "unknown", evidence: [], note };
    }

    if (result.status === "fail") {
      const { active, expired } = pickException(config.exceptions, control.id, today);
      if (active) result.exception = active;
      else if (expired) {
        result.expiredException = expired;
        result.evidence = [...result.evidence, { message: `An exception for this control expired on ${expired.expires}; it is enforced again.` }];
      }
    }
    results.push(result);
  }

  const summary: Summary = {
    pass: 0,
    fail: 0,
    unknown: 0,
    na: 0,
    suppressed: 0,
    blocking: 0,
    bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>
  };
  for (const r of results) {
    if (r.status === "fail" && r.exception) {
      summary.suppressed++;
      continue;
    }
    summary[r.status]++;
    if (r.status === "fail") {
      summary.bySeverity[r.severity]++;
      if (r.mode === "enforce") summary.blocking++;
    }
  }

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    generatedAt: now.toISOString(),
    repo: opts.repo,
    profile,
    coverage: { filesTotal: snapshot.paths.length, filesRead: snapshot.filesRead(), treeTruncated: snapshot.truncated },
    results,
    summary,
    configIssues: loaded.issues
  };
}

/** Which live failures make a run "fail": only enforced ones, enforced + warned ones, or none. */
export type FailOn = "enforce" | "warn" | "never";

export function failingCount(report: Report, failOn: FailOn): number {
  if (failOn === "never") return 0;
  return report.results.filter((r) => r.status === "fail" && !r.exception && (r.mode === "enforce" || (failOn === "warn" && r.mode === "warn"))).length;
}
