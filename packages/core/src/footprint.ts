import type { Footprint, FootprintBucket, PullRequestClass, PullRequestClassification } from "./types.ts";

/** Minimum merged PRs in a class before we publish a median for it. */
export const MIN_SAMPLE = 5;

/** The subset of the GitHub pull request payload we rely on. */
export interface PullRequestInput {
  number: number;
  title?: string | null;
  body?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
  head?: { ref?: string | null } | null;
  labels?: Array<{ name?: string | null }> | null;
  created_at?: string | null;
  merged_at?: string | null;
}

const AUTOMATION_LOGIN = /(^|[-_])(dependabot|renovate|github-actions|pre-commit-ci|snyk-bot|mend|whitesource|greenkeeper|allcontributors|release-please|changeset-bot)(\[bot\])?$/i;
const AGENT_LOGIN = /^(copilot-swe-agent|copilot|devin-ai-integration|claude|cursor|cursoragent|codex|openhands|sweep-ai|google-labs-jules|jules|codegen-sh|factory-droid)(\[bot\])?$/i;
const AGENT_BRANCH = /^(copilot|claude|codex|cursor|devin|jules|openhands|sweep|codegen)[/-]/i;
const AI_BODY_MARKERS: Array<[RegExp, string]> = [
  [/generated with \[?claude code\]?/i, "PR text says it was generated with Claude Code"],
  [/co-authored-by:\s*claude/i, "PR text credits Claude as co-author"],
  [/co-authored-by:\s*copilot/i, "PR text credits Copilot as co-author"],
  [/\bgenerated (?:by|with) (?:chatgpt|codex|cursor|copilot|gemini|devin)\b/i, "PR text says it was AI-generated"],
  [/🤖\s*generated/i, "PR text has an AI-generated footer"]
];
const AI_LABEL = /^(ai[- ]generated|ai[- ]assisted|copilot|claude|codex|llm[- ]generated)$/i;

function hoursBetween(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? ms / 3_600_000 : null;
}

export function classifyPullRequest(pr: PullRequestInput): PullRequestClassification {
  const login = pr.user?.login ?? "";
  // Login-based rules need a bot identity so a human who happens to be called "cursor" is not misclassified.
  const isBot = pr.user?.type === "Bot" || login.endsWith("[bot]");
  const evidence: string[] = [];
  let cls: PullRequestClass = "no-signal";

  if (isBot && AUTOMATION_LOGIN.test(login)) {
    cls = "automation";
    evidence.push(`author ${login} is a dependency/release automation bot`);
  } else if (isBot && AGENT_LOGIN.test(login)) {
    cls = "ai-agent";
    evidence.push(`author ${login} is a coding-agent identity`);
  } else if (pr.head?.ref && AGENT_BRANCH.test(pr.head.ref)) {
    cls = "ai-agent";
    evidence.push(`branch ${pr.head.ref} follows a coding-agent naming convention`);
  } else {
    const body = pr.body ?? "";
    for (const [re, why] of AI_BODY_MARKERS) {
      if (re.test(body)) {
        cls = "ai-signal";
        evidence.push(why);
        break;
      }
    }
    const label = (pr.labels ?? []).map((l) => l.name ?? "").find((n) => AI_LABEL.test(n));
    if (label) {
      cls = cls === "no-signal" ? "ai-signal" : cls;
      evidence.push(`label "${label}"`);
    }
  }

  return { number: pr.number, class: cls, evidence, hoursToMerge: hoursBetween(pr.created_at, pr.merged_at) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const CLASSES: PullRequestClass[] = ["ai-agent", "ai-signal", "automation", "no-signal"];

export const FOOTPRINT_CAVEAT =
  "Based on public signals only: bot identities, agent branch names and markers in PR text. 'no-signal' means no AI marker was found, not that no AI was used, so AI share is a lower bound. Medians appear only with at least " +
  `${MIN_SAMPLE} merged PRs in a class. This is correlation, not measured impact.`;

export function summarizeFootprint(prs: PullRequestInput[], now: Date = new Date()): Footprint {
  const classified = prs.map((pr) => ({ pr, c: classifyPullRequest(pr) }));
  const merged = classified.filter((x) => x.pr.merged_at);
  const created = prs.map((p) => Date.parse(p.created_at ?? "")).filter((t) => Number.isFinite(t));
  const windowDays = created.length ? Math.max(1, Math.ceil((now.getTime() - Math.min(...created)) / 86_400_000)) : 0;

  const buckets: FootprintBucket[] = CLASSES.map((cls) => {
    const inClass = classified.filter((x) => x.c.class === cls);
    const hours = inClass.map((x) => x.c.hoursToMerge).filter((h): h is number => h !== null);
    return {
      class: cls,
      count: inClass.length,
      medianHoursToMerge: hours.length >= MIN_SAMPLE ? Math.round(median(hours) * 10) / 10 : null
    };
  });

  return { sampled: prs.length, merged: merged.length, windowDays, buckets, caveat: FOOTPRINT_CAVEAT };
}
