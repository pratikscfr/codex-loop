import { parse as parseYaml } from "yaml";
import type { Control, Evidence } from "../types.ts";
import { prefetch } from "../snapshot.ts";
import { capList, isRecord } from "../util.ts";
import { fail, pass, unknown, WORKFLOW_FILE } from "./helpers.ts";

const MAX_WORKFLOWS = 25;

const CI_FILES = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\/config\.yml$/,
  /^Jenkinsfile$/,
  /^azure-pipelines\.ya?ml$/,
  /^bitbucket-pipelines\.yml$/,
  /^\.buildkite\//,
  /^\.drone\.yml$/,
  /^\.travis\.yml$/,
  /^cloudbuild\.ya?ml$/,
  /^\.woodpecker\//
];

export const CI_CONFIGURED: Control = {
  id: "CDX-010",
  title: "Continuous integration is configured",
  category: "ci",
  severity: "medium",
  rationale: "Changes that are not built and tested automatically reach main on trust alone; the cost of each regression lands on whoever finds it.",
  remediation: "Add a CI workflow (for example .github/workflows/ci.yml) that installs, builds and tests on every pull request.",
  agentRule: "Make sure CI passes before proposing a change; never disable or skip CI checks to make a change pass.",
  appliesTo: (p) => p.ecosystems.length > 0,
  async check({ snapshot }) {
    const found = snapshot.paths.find((path) => CI_FILES.some((re) => re.test(path)));
    return found ? pass({ path: found, message: `CI configuration found at ${found}.` }) : fail({ message: "No CI configuration found (GitHub Actions, GitLab CI, CircleCI, Jenkins, ...)." });
  }
};

export const ACTIONS_PINNED: Control = {
  id: "CDX-011",
  title: "GitHub Actions are pinned to full commit SHAs",
  category: "ci",
  severity: "medium",
  rationale:
    "A tag like @v4 can be moved by whoever controls the action's repository. Pinning to a full commit SHA means a compromised upstream cannot silently change what runs in your pipeline with your secrets.",
  remediation: "Replace `uses: owner/action@v4` with `uses: owner/action@<40-char-sha> # v4`. Dependabot and Renovate can keep the SHAs current.",
  agentRule: "When adding or editing GitHub Actions, pin every `uses:` to a full 40-character commit SHA with a version comment.",
  appliesTo: (p) => p.hasGithubActions,
  async check({ snapshot }) {
    const files = snapshot.paths.filter((p) => WORKFLOW_FILE.test(p)).slice(0, MAX_WORKFLOWS);
    await prefetch(snapshot, files);
    const bad: Evidence[] = [];
    let readable = 0;
    for (const file of files) {
      const text = await snapshot.read(file);
      if (text === null) continue;
      readable++;
      text.split("\n").forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        const m = /^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)['"]?/.exec(line);
        if (!m) return;
        const ref = m[1]!;
        if (ref.startsWith("./") || ref.startsWith("docker://")) return;
        if (!/@[0-9a-f]{40}$/i.test(ref)) bad.push({ path: file, line: i + 1, message: `${ref} is not pinned to a full commit SHA.` });
      });
    }
    if (readable === 0) return unknown("Workflow files could not be read.");
    return bad.length
      ? fail(...capList(bad, 12, (n) => ({ message: `...and ${n} more unpinned action reference(s).` })))
      : pass({ message: `All action references in ${readable} workflow file(s) are pinned.` });
  }
};

export const WORKFLOW_PERMISSIONS: Control = {
  id: "CDX-012",
  title: "GitHub workflows declare least-privilege permissions",
  category: "ci",
  severity: "medium",
  rationale:
    "Without an explicit `permissions:` block, the workflow token may get broad default write access. A compromised step or dependency can then push code or tamper with releases.",
  remediation: "Add top-level `permissions: contents: read` to each workflow and grant more only to the jobs that need it.",
  agentRule: "Every workflow you write declares `permissions:` explicitly, read-only by default; grant write access per job only when required.",
  appliesTo: (p) => p.hasGithubActions,
  async check({ snapshot }) {
    const files = snapshot.paths.filter((p) => WORKFLOW_FILE.test(p)).slice(0, MAX_WORKFLOWS);
    await prefetch(snapshot, files);
    const bad: Evidence[] = [];
    let ok = 0;
    let unreadable = 0;
    for (const file of files) {
      const text = await snapshot.read(file);
      if (text === null) {
        unreadable++;
        continue;
      }
      let doc: unknown;
      try {
        doc = parseYaml(text);
      } catch {
        unreadable++;
        continue;
      }
      if (!isRecord(doc)) {
        unreadable++;
        continue;
      }
      if (doc.permissions === "write-all") {
        bad.push({ path: file, message: "Top-level `permissions: write-all` grants every scope." });
        continue;
      }
      if (doc.permissions !== undefined && doc.permissions !== null) {
        ok++;
        continue;
      }
      const jobs = isRecord(doc.jobs) ? doc.jobs : {};
      const missing = Object.entries(jobs)
        .filter(([, job]) => !isRecord(job) || job.permissions === undefined)
        .map(([name]) => name);
      if (Object.keys(jobs).length > 0 && missing.length === 0) ok++;
      else bad.push({ path: file, message: `No top-level \`permissions:\`${missing.length ? `; job(s) without their own: ${missing.slice(0, 5).join(", ")}` : ""}.` });
    }
    if (bad.length) return fail(...capList(bad, 12, (n) => ({ message: `...and ${n} more workflow(s).` })));
    if (ok === 0) return unknown(`Could not parse ${unreadable} workflow file(s).`);
    return unreadable ? unknown(`${ok} workflow(s) pass but ${unreadable} could not be parsed.`) : pass({ message: `${ok} workflow file(s) declare permissions.` });
  }
};
