import type { ControlResult, Report, Severity } from "@codex-loop/core";

export function result(
  id: string,
  status: ControlResult["status"],
  over: Partial<ControlResult> = {}
): ControlResult {
  return {
    id,
    title: `Title of ${id}`,
    category: "ci",
    severity: "medium",
    status,
    mode: "audit",
    evidence: status === "fail" ? [{ path: "package.json", line: 3, message: `${id} failed here` }] : [],
    rationale: `Why ${id} matters`,
    remediation: `Fix ${id}`,
    ...over
  };
}

export function makeReport(results: ControlResult[], over: Partial<Report> = {}): Report {
  const count = (s: string) => results.filter((r) => r.status === s && !r.exception).length;
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of results) if (r.status === "fail" && !r.exception) bySeverity[r.severity]++;
  return {
    schemaVersion: 1,
    engineVersion: "0.1.0",
    generatedAt: "2026-10-05T12:00:00.000Z",
    repo: { owner: "acme", repo: "widgets", ref: "main", sha: "abc123" },
    profile: {
      languages: ["TypeScript"],
      ecosystems: ["npm"],
      monorepo: false,
      hasDocker: false,
      hasWrangler: false,
      hasGithubActions: true,
      hasTypeScript: true,
      fileCount: 10,
      sizeBucket: "small",
      commands: {}
    },
    coverage: { filesTotal: 10, filesRead: 4, treeTruncated: false },
    results,
    summary: {
      pass: count("pass"),
      fail: count("fail"),
      unknown: count("unknown"),
      na: count("na"),
      suppressed: results.filter((r) => r.status === "fail" && r.exception).length,
      blocking: results.filter((r) => r.status === "fail" && !r.exception && r.mode === "enforce").length,
      bySeverity
    },
    configIssues: [],
    ...over
  };
}

/** A report with a known mix: CDX-001 fail, CDX-002 pass, CDX-003 suppressed fail, CDX-004 unknown, CDX-005 fail (high). */
export function sampleReport(): Report {
  return makeReport([
    result("CDX-001", "fail", { severity: "critical", mode: "enforce" }),
    result("CDX-002", "pass"),
    result("CDX-003", "fail", {
      exception: { control: "CDX-003", reason: "legacy", expires: "2027-01-01" }
    }),
    result("CDX-004", "unknown", { note: "could not read" }),
    result("CDX-005", "fail", { severity: "high" })
  ]);
}
