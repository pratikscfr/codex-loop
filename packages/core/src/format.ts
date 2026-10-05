import type { ControlResult, Evidence, Report, Severity } from "./types.ts";

export const COMMENT_MARKER = "<!-- codex-loop:report -->";
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const RANK = Object.fromEntries(SEVERITY_ORDER.map((s, i) => [s, i])) as Record<Severity, number>;

/** Escape repo-derived text for safe inclusion in GitHub-flavored markdown. */
export function mdText(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}[\]<>|#]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : `\\${c}`));
}

export function mdCode(s: string): string {
  return `\`${s.replace(/[\r\n`]+/g, " ")}\``;
}

function where(e: Evidence): string {
  if (!e.path) return "";
  return mdCode(e.line ? `${e.path}:${e.line}` : e.path);
}

function evidenceLine(e: Evidence): string {
  const loc = where(e);
  return loc ? `${loc} ${mdText(e.message)}` : mdText(e.message);
}

function sortResults(rs: ControlResult[]): ControlResult[] {
  return [...rs].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id));
}

function isLiveFailure(r: ControlResult): boolean {
  return r.status === "fail" && !r.exception;
}

export interface MarkdownOptions {
  /** Prefix with a hidden marker so a bot can find and update its own comment. */
  marker?: boolean;
  maxEvidence?: number;
}

export function renderMarkdown(report: Report, opts: MarkdownOptions = {}): string {
  const max = opts.maxEvidence ?? 4;
  const s = report.summary;
  const out: string[] = [];
  if (opts.marker) out.push(COMMENT_MARKER);
  out.push("## codex-loop report", "");

  const repo = report.repo ? `${report.repo.owner}/${report.repo.repo}` : "repository";
  const sha = report.repo?.sha ? ` @ ${report.repo.sha.slice(0, 7)}` : "";
  out.push(`**${mdText(repo)}**${sha} · ${report.profile.fileCount} files · ${report.profile.languages.join(", ") || "no recognized languages"}`, "");
  out.push(
    `✅ ${s.pass} passing · ❌ ${s.fail} failing · ❔ ${s.unknown} undetermined · ➖ ${s.na} not applicable` +
      (s.suppressed ? ` · 🔕 ${s.suppressed} excepted` : "") +
      (s.blocking ? ` · **🚫 ${s.blocking} blocking**` : ""),
    ""
  );

  const failing = sortResults(report.results.filter(isLiveFailure));
  if (failing.length) {
    out.push("### Failing", "");
    for (const r of failing) {
      out.push(`- **${r.id}** ${mdText(r.title)} · ${r.severity} · ${r.mode}`);
      for (const e of r.evidence.slice(0, max)) out.push(`  - ${evidenceLine(e)}`);
      if (r.evidence.length > max) out.push(`  - …and ${r.evidence.length - max} more`);
      out.push(`  - Fix: ${mdText(r.remediation)}`);
    }
    out.push("");
  }

  const excepted = report.results.filter((r) => r.status === "fail" && r.exception);
  if (excepted.length) {
    out.push("### Excepted (time-boxed)", "");
    for (const r of excepted) {
      const ex = r.exception!;
      out.push(`- **${r.id}** ${mdText(r.title)} · until ${ex.expires} · ${mdText(ex.reason)}${ex.owner ? ` (${mdText(ex.owner)})` : ""}`);
    }
    out.push("");
  }

  const unknown = sortResults(report.results.filter((r) => r.status === "unknown"));
  if (unknown.length) {
    out.push("### Could not determine", "");
    for (const r of unknown) {
      const why = r.note ?? r.evidence[0]?.message ?? "Not enough information.";
      out.push(`- **${r.id}** ${mdText(r.title)}: ${mdText(why)}`);
    }
    out.push("");
  }

  const passing = sortResults(report.results.filter((r) => r.status === "pass"));
  if (passing.length) {
    out.push("<details><summary>Passing controls</summary>", "");
    for (const r of passing) out.push(`- **${r.id}** ${mdText(r.title)}`);
    out.push("", "</details>", "");
  }

  if (report.configIssues.length) {
    out.push("### Configuration issues", "");
    for (const i of report.configIssues) out.push(`- ${mdText(i)}`);
    out.push("");
  }

  const c = report.coverage;
  out.push(`<sub>Read ${c.filesRead} of ${c.filesTotal} files${c.treeTruncated ? " (file listing was truncated by GitHub; coverage is partial)" : ""}. Deterministic checks only; no AI is used to decide pass or fail.</sub>`);
  return out.join("\n");
}

const COLORS = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };

export function renderText(report: Report, opts: { color?: boolean; verbose?: boolean } = {}): string {
  const c = (code: keyof typeof COLORS, text: string) => (opts.color ? `${COLORS[code]}${text}${COLORS.reset}` : text);
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const s = report.summary;
  const out: string[] = [];
  const repo = report.repo ? `${report.repo.owner}/${report.repo.repo}` : "repository";
  out.push(c("bold", `codex-loop: ${clean(repo)}`) + c("dim", `  (${report.profile.fileCount} files, ${report.profile.languages.join(", ") || "no recognized languages"})`));
  out.push(`${c("green", `${s.pass} pass`)}  ${c("red", `${s.fail} fail`)}  ${s.unknown} unknown  ${c("dim", `${s.na} n/a`)}${s.suppressed ? `  ${s.suppressed} excepted` : ""}${s.blocking ? "  " + c("red", `${s.blocking} blocking`) : ""}`);
  out.push("");

  for (const r of sortResults(report.results)) {
    if (r.status === "na") continue;
    if (r.status === "pass" && !opts.verbose) continue;
    const tag =
      r.status === "pass" ? c("green", "PASS") : r.status === "unknown" ? c("yellow", "UNKN") : r.exception ? c("dim", "EXCP") : r.mode === "enforce" ? c("red", "FAIL") : r.mode === "warn" ? c("yellow", "WARN") : c("dim", "NOTE");
    out.push(`${tag} ${r.id} ${clean(r.title)} ${c("dim", `[${r.severity}, ${r.mode}]`)}`);
    if (r.status !== "pass" || opts.verbose) {
      const evidence = r.evidence.length ? r.evidence : r.note ? [{ message: r.note }] : [];
      for (const e of evidence.slice(0, 5)) out.push(`     ${e.path ? `${clean(e.path)}${e.line ? `:${e.line}` : ""}: ` : ""}${clean(e.message)}`);
      if (isLiveFailure(r)) out.push(c("dim", `     fix: ${r.remediation}`));
    }
  }
  for (const i of report.configIssues) out.push(c("yellow", `config: ${clean(i)}`));
  const cov = report.coverage;
  out.push("", c("dim", `read ${cov.filesRead}/${cov.filesTotal} files${cov.treeTruncated ? " (listing truncated)" : ""}`));
  return out.join("\n");
}

function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProp(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** GitHub Actions workflow commands: one annotation per evidence item of each live failure. */
export function githubAnnotations(report: Report, maxPerControl = 10): string[] {
  const lines: string[] = [];
  for (const r of sortResults(report.results)) {
    if (!isLiveFailure(r)) continue;
    const level = r.mode === "enforce" ? "error" : r.mode === "warn" ? "warning" : "notice";
    const items = r.evidence.length ? r.evidence : [{ message: r.title }];
    for (const e of items.slice(0, maxPerControl)) {
      const props = [e.path ? `file=${escapeProp(e.path)}` : "", e.path && e.line ? `line=${e.line}` : "", `title=${escapeProp(`${r.id} ${r.title}`)}`].filter(Boolean).join(",");
      lines.push(`::${level} ${props}::${escapeData(e.message)}`);
    }
  }
  return lines;
}
