import type { Control, Evidence } from "../types.ts";
import { ancestors, basename, capList, dirname, isRecord, isVendored, join, NON_PROD } from "../util.ts";
import { fail, pass } from "./helpers.ts";

const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const PY_LOCKS = ["poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock", "pylock.toml"];

/** Manifests whose directory has no manifest of the same kind above it (workspace roots / standalone projects). */
function topManifests(paths: readonly string[], name: string): string[] {
  const all = paths.filter((p) => basename(p) === name && !isVendored(p) && !NON_PROD.test(p));
  const dirs = new Set(all.map(dirname));
  return all.filter((p) => !ancestors(dirname(p)).slice(1).some((d) => dirs.has(d)));
}

export const LOCKFILES: Control = {
  id: "CDX-020",
  title: "Dependency lockfiles are committed",
  category: "supply-chain",
  severity: "medium",
  rationale:
    "Without a lockfile every install can resolve different versions. Builds stop being reproducible and a malicious or broken release of any transitive dependency flows straight into your artifact.",
  remediation: "Commit the lockfile for your package manager (package-lock.json, pnpm-lock.yaml, yarn.lock, go.sum, poetry.lock, uv.lock, Cargo.lock, ...).",
  agentRule: "Commit lockfile changes together with any dependency change, and never delete a lockfile to work around an install error.",
  appliesTo: (p) => p.ecosystems.some((e) => ["npm", "go", "python", "cargo", "bundler", "composer"].includes(e)),
  async check({ snapshot }) {
    const paths = snapshot.paths;
    const set = new Set(paths);
    const hasNear = (dir: string, names: readonly string[]) =>
      ancestors(dir).some((d) => names.some((n) => set.has(join(d, n))));
    const hard: Evidence[] = [];
    const soft: Evidence[] = [];

    for (const pkg of topManifests(paths, "package.json")) {
      if (!hasNear(dirname(pkg), NPM_LOCKS)) hard.push({ path: pkg, message: "package.json has no lockfile in this directory or any parent." });
    }
    // Every Go module (including nested ones) keeps its own go.sum.
    for (const mod of paths.filter((p) => basename(p) === "go.mod" && !isVendored(p) && !NON_PROD.test(p))) {
      const dir = dirname(mod);
      if (set.has(join(dir, "go.sum"))) continue;
      const text = await snapshot.read(mod);
      // A module with no dependencies legitimately has no go.sum.
      if (text !== null && !/^\s*require\b/m.test(text)) continue;
      hard.push({ path: mod, message: "go.mod has dependencies but no go.sum beside it." });
    }
    for (const kind of ["pyproject.toml", "Pipfile", "setup.py"]) {
      for (const manifest of topManifests(paths, kind)) {
        const dir = dirname(manifest);
        const hasLock = hasNear(dir, PY_LOCKS);
        const hasReqs = ancestors(dir).some((d) => paths.some((p) => dirname(p) === d && /^requirements[^/]*\.txt$/.test(basename(p))));
        if (!hasLock && !hasReqs) hard.push({ path: manifest, message: "No lockfile or pinned requirements file found for this Python project." });
      }
    }
    for (const manifest of topManifests(paths, "Cargo.toml")) {
      if (!hasNear(dirname(manifest), ["Cargo.lock"])) soft.push({ path: manifest, message: "No Cargo.lock (library crates sometimes omit it; applications should commit it)." });
    }
    for (const manifest of topManifests(paths, "Gemfile")) {
      if (!hasNear(dirname(manifest), ["Gemfile.lock"])) soft.push({ path: manifest, message: "No Gemfile.lock (gems sometimes omit it; applications should commit it)." });
    }
    for (const manifest of topManifests(paths, "composer.json")) {
      if (!hasNear(dirname(manifest), ["composer.lock"])) soft.push({ path: manifest, message: "No composer.lock (libraries sometimes omit it; applications should commit it)." });
    }

    if (hard.length) return fail(...capList(hard, 10, (n) => ({ message: `...and ${n} more manifest(s) without a lockfile.` })));
    if (soft.length) return { status: "unknown", evidence: soft.slice(0, 10) };
    return pass({ message: "Every project manifest has a lockfile." });
  }
};

const DEP_BOT_FILES = [
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json"
];

export const DEPENDENCY_UPDATES: Control = {
  id: "CDX-021",
  title: "Automated dependency updates are configured",
  category: "supply-chain",
  severity: "low",
  defaultMode: "audit",
  rationale:
    "Dependencies that only change when someone remembers accumulate known vulnerabilities. Automated update PRs keep the gap small and each change reviewable.",
  remediation: "Add .github/dependabot.yml (or a Renovate config) covering your package ecosystems and GitHub Actions. If updates are configured at the organization level, record an exception.",
  agentRule: "Prefer the repository's existing dependency versions; when you must add a dependency, choose a maintained one and pin it through the lockfile.",
  appliesTo: (p) => p.ecosystems.length > 0 || p.hasGithubActions || p.hasDocker,
  async check({ snapshot }) {
    const file = DEP_BOT_FILES.find((f) => snapshot.paths.includes(f));
    if (file) return pass({ path: file, message: `${file} present.` });
    if (snapshot.paths.includes("package.json")) {
      const text = await snapshot.read("package.json");
      if (text) {
        try {
          const pkg: unknown = JSON.parse(text);
          if (isRecord(pkg) && pkg.renovate !== undefined) return pass({ path: "package.json", message: "Renovate configured in package.json." });
        } catch {
          /* fall through to the failure below */
        }
      }
    }
    return fail({ message: "No Dependabot or Renovate configuration found (it may be configured at the organization level)." });
  }
};
