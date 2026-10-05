import type { Control, Evidence, Snapshot } from "../types.ts";
import { basename, dirname, isRecord, isVendored, join, NON_PROD, parseJsonc } from "../util.ts";
import { fail, pass, unknown } from "./helpers.ts";

type Strict = "true" | "false" | "unset" | "unknown";

/** Resolve "./a/../b" relative to a directory inside the repo; returns null if it escapes the root. */
function resolveRel(dir: string, rel: string): string | null {
  const parts = dir === "" ? [] : dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function withJson(path: string): string {
  return path.endsWith(".json") ? path : `${path}.json`;
}

/** Effective `compilerOptions.strict` for a tsconfig, following `extends` and project `references`. */
async function effectiveStrict(snapshot: Snapshot, path: string, depth = 0, seen = new Set<string>()): Promise<Strict> {
  if (depth > 6 || seen.has(path)) return "unknown";
  seen.add(path);
  const text = await snapshot.read(path);
  if (text === null) return "unknown";
  const cfg = parseJsonc<Record<string, unknown>>(text);
  if (!isRecord(cfg)) return "unknown";
  const options = cfg.compilerOptions;
  if (isRecord(options) && typeof options.strict === "boolean") return options.strict ? "true" : "false";

  const dir = dirname(path);
  const ext = typeof cfg.extends === "string" ? [cfg.extends] : Array.isArray(cfg.extends) ? cfg.extends.filter((e): e is string => typeof e === "string") : [];
  // Later entries in `extends` override earlier ones.
  for (const entry of [...ext].reverse()) {
    if (entry.startsWith(".")) {
      const target = resolveRel(dir, withJson(entry));
      if (target !== null && snapshot.paths.includes(target)) {
        const r = await effectiveStrict(snapshot, target, depth + 1, seen);
        if (r !== "unset") return r;
      } else return "unknown";
    } else if (entry.startsWith("@tsconfig/")) {
      return "true"; // the community base configs all enable strict
    } else if (/strict/i.test(entry)) {
      return "true";
    } else {
      return "unknown"; // a package we cannot read from the repository
    }
  }

  // Solution-style config (e.g. Vite): defer to the referenced projects.
  if (Array.isArray(cfg.references) && cfg.references.length > 0) {
    const results: Strict[] = [];
    for (const ref of cfg.references) {
      if (!isRecord(ref) || typeof ref.path !== "string") continue;
      const target = resolveRel(dir, ref.path);
      if (target === null) continue;
      const candidate = snapshot.paths.includes(withJson(target)) && ref.path.endsWith(".json") ? target : snapshot.paths.includes(join(target, "tsconfig.json")) ? join(target, "tsconfig.json") : withJson(target);
      if (!snapshot.paths.includes(candidate)) continue;
      results.push(await effectiveStrict(snapshot, candidate, depth + 1, seen));
    }
    if (results.length > 0) {
      if (results.includes("false")) return "false";
      if (results.includes("unset")) return "unset";
      if (results.includes("unknown")) return "unknown";
      return "true";
    }
  }
  return "unset";
}

export const TS_STRICT: Control = {
  id: "CDX-060",
  title: "TypeScript strict mode is enabled",
  category: "quality",
  severity: "medium",
  rationale: "Strict mode turns a large class of runtime errors (null access, implicit any, unsound function types) into compile errors. It is far cheaper to adopt at the start than to retrofit.",
  remediation: 'Set `"strict": true` in tsconfig.json compilerOptions (explicitly, so behavior does not depend on the TypeScript version).',
  agentRule: "Write code that compiles under TypeScript `strict`; do not use `any` or `// @ts-ignore` to silence errors, fix the types.",
  appliesTo: (p) => p.hasTypeScript,
  async check({ snapshot }) {
    const configs = snapshot.paths
      .filter((p) => basename(p) === "tsconfig.json" && !isVendored(p) && !NON_PROD.test(p))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, 8);
    if (configs.length === 0) {
      return snapshot.paths.some((p) => /(^|\/)deno\.jsonc?$/.test(p))
        ? pass({ message: "Deno projects are strict by default." })
        : unknown("TypeScript files found but no tsconfig.json to evaluate.");
    }
    const bad: Evidence[] = [];
    let indeterminate = 0;
    for (const path of configs) {
      const r = await effectiveStrict(snapshot, path);
      if (r === "false") bad.push({ path, message: "compilerOptions.strict is set to false." });
      else if (r === "unset") bad.push({ path, message: "compilerOptions.strict is not set anywhere in this config's extends chain." });
      else if (r === "unknown") indeterminate++;
    }
    if (bad.length) return fail(...bad);
    return indeterminate ? unknown(`${indeterminate} tsconfig(s) extend a base that cannot be read from the repository.`) : pass({ message: `strict is enabled in ${configs.length} tsconfig(s).` });
  }
};

const TEST_PATH = [
  /(^|\/)(__tests__|tests?|specs?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py|rs)$/,
  /(^|\/)test_[^/]+\.py$/,
  /(Test|Tests|IT)\.(java|kt)$/,
  /_spec\.rb$/
];

export const TESTS_EXIST: Control = {
  id: "CDX-061",
  title: "The project has automated tests",
  category: "quality",
  severity: "medium",
  rationale: "Tests are the feedback loop that lets humans and coding agents change code with confidence. Without them every change is a guess, and agent-written changes most of all.",
  remediation: "Add tests for the core behavior and a `test` script (or the language's standard runner) so CI and agents can run them with one command.",
  agentRule: "Add or update tests for every behavior change, run the project's test command before finishing, and never delete or skip tests to make a change pass.",
  appliesTo: (p) => p.ecosystems.length > 0,
  async check({ snapshot, profile }) {
    const own = snapshot.paths.filter((p) => !isVendored(p));
    const testFile = own.find((p) => TEST_PATH.some((re) => re.test(p)));
    if (testFile) return pass({ path: testFile, message: `Tests found (for example ${testFile}).` });
    if (profile.commands.test) return pass({ message: `A test command is defined: ${profile.commands.test}.` });
    return fail({ message: "No test files or test command found." });
  }
};
