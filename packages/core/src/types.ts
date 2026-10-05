/**
 * Shared contract for every surface (CLI, GitHub Action, Worker, MCP server).
 * Everything here is plain data so a Report can be stored, diffed and rendered anywhere.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** Rollout stage for a control: audit (record only) → warn (surface) → enforce (block). */
export type Mode = "audit" | "warn" | "enforce";

/**
 * pass    – the repo satisfies the control
 * fail    – the repo violates it (evidence explains why)
 * na      – the control does not apply to this repo (profile said so)
 * unknown – we could not decide (missing data, unsupported format). Never counted as a failure.
 */
export type Status = "pass" | "fail" | "na" | "unknown";

export type Category =
  | "hygiene"
  | "ci"
  | "supply-chain"
  | "secrets"
  | "containers"
  | "cloudflare"
  | "quality"
  | "agents";

/** A read-only view of a repository at one commit. Implemented for disk, GitHub and memory. */
export interface Snapshot {
  /** Every file path in the repo, POSIX-style, relative to the root. */
  readonly paths: readonly string[];
  /** Text content of a file; null if missing, binary, or larger than the size limit. */
  read(path: string): Promise<string | null>;
  /** True when the underlying file listing was cut off (very large repos). */
  readonly truncated: boolean;
  /** How many distinct files have been read so far (for coverage reporting). */
  readonly filesRead: () => number;
}

export interface Profile {
  /** Languages ranked by number of files. */
  languages: string[];
  ecosystems: Array<
    "npm" | "go" | "python" | "cargo" | "maven" | "gradle" | "bundler" | "composer" | "dotnet"
  >;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  monorepo: boolean;
  hasDocker: boolean;
  hasWrangler: boolean;
  hasGithubActions: boolean;
  hasTypeScript: boolean;
  fileCount: number;
  sizeBucket: "tiny" | "small" | "medium" | "large";
  /** Best-effort commands discovered from manifests. Only ever used as hints. */
  commands: {
    install?: string;
    build?: string;
    test?: string;
    lint?: string;
    typecheck?: string;
    dev?: string;
  };
}

export interface Evidence {
  path?: string;
  line?: number;
  message: string;
}

export interface CheckContext {
  snapshot: Snapshot;
  profile: Profile;
  /** Injected clock so results are deterministic and testable. */
  now: Date;
}

export interface CheckOutcome {
  status: "pass" | "fail" | "unknown";
  evidence: Evidence[];
}

export interface Control {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  /** Why the standard exists. Shown to humans and used as grounding for the LLM. */
  rationale: string;
  /** What to do about a failure. */
  remediation: string;
  /** One imperative line that goes into generated agent context (AGENTS.md). */
  agentRule: string;
  /** Default rollout stage when the repo config does not say otherwise. */
  defaultMode?: Mode;
  appliesTo?: (profile: Profile) => boolean;
  check(ctx: CheckContext): Promise<CheckOutcome>;
}

export interface ControlException {
  control: string;
  reason: string;
  /** ISO date (YYYY-MM-DD). Required: exceptions are always time-boxed. */
  expires: string;
  owner?: string;
}

export interface Config {
  version: 1;
  /** Default mode for controls that are not listed under `controls`. */
  mode: Mode;
  controls: Record<string, { mode?: Mode; disabled?: boolean }>;
  exceptions: ControlException[];
  /** Character budget for generated agent context. */
  agentContextBudget?: number;
}

export interface ControlResult {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  status: Status;
  mode: Mode;
  evidence: Evidence[];
  rationale: string;
  remediation: string;
  /** Set when an active, unexpired exception suppresses a failure. */
  exception?: ControlException;
  /** Set when an exception exists but has expired (the failure is live again). */
  expiredException?: ControlException;
  /** Human-readable reason an "unknown" was returned (e.g. the check threw). */
  note?: string;
}

export interface Coverage {
  filesTotal: number;
  filesRead: number;
  treeTruncated: boolean;
}

export interface Summary {
  pass: number;
  fail: number;
  unknown: number;
  na: number;
  /** Failures silenced by an active exception. */
  suppressed: number;
  /** Live failures in `enforce` mode: these are the ones that should fail CI. */
  blocking: number;
  bySeverity: Record<Severity, number>;
}

/** Output of the optional LLM layer. Always presented separately from verified results. */
export interface Advisory {
  generatedBy: string;
  generatedAt: string;
  summary: string;
  priorities: Array<{ controlId: string; why: string; firstStep: string }>;
}

export type PullRequestClass = "ai-agent" | "ai-signal" | "automation" | "no-signal";

export interface PullRequestClassification {
  number: number;
  class: PullRequestClass;
  /** Why we classified it that way. Always present for anything but "no-signal". */
  evidence: string[];
  hoursToMerge: number | null;
}

export interface FootprintBucket {
  class: PullRequestClass;
  count: number;
  /** Median hours from open to merge; null when fewer than MIN_SAMPLE merged PRs. */
  medianHoursToMerge: number | null;
}

export interface Footprint {
  sampled: number;
  merged: number;
  windowDays: number;
  buckets: FootprintBucket[];
  /** Always shown with the numbers: "no-signal" is a lower bound on human work, not proof. */
  caveat: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
  sha?: string;
  url?: string;
}

export interface Report {
  schemaVersion: 1;
  engineVersion: string;
  generatedAt: string;
  repo?: RepoRef;
  profile: Profile;
  coverage: Coverage;
  results: ControlResult[];
  summary: Summary;
  /** Problems found in .codex-loop.yml. Non-fatal: the engine falls back to defaults. */
  configIssues: string[];
  footprint?: Footprint;
  advisory?: Advisory;
}
