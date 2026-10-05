import type { Profile, Snapshot } from "./types.ts";
import { basename, dirname, isRecord, isVendored } from "./util.ts";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "c++",
  cpp: "c++",
  hpp: "c++",
  sh: "shell",
  bash: "shell"
};

const ECOSYSTEM_MANIFESTS: Array<[Profile["ecosystems"][number], RegExp]> = [
  ["npm", /(^|\/)package\.json$/],
  ["go", /(^|\/)go\.mod$/],
  ["python", /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.py|setup\.cfg|Pipfile)$/],
  ["cargo", /(^|\/)Cargo\.toml$/],
  ["maven", /(^|\/)pom\.xml$/],
  ["gradle", /(^|\/)build\.gradle(\.kts)?$/],
  ["bundler", /(^|\/)Gemfile$/],
  ["composer", /(^|\/)composer\.json$/],
  ["dotnet", /\.(csproj|fsproj|sln)$/]
];

const LOCKFILE_PM: Array<[NonNullable<Profile["packageManager"]>, string]> = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
  ["npm", "npm-shrinkwrap.json"]
];

function sizeBucket(count: number): Profile["sizeBucket"] {
  if (count < 50) return "tiny";
  if (count < 500) return "small";
  if (count < 5000) return "medium";
  return "large";
}

function parseJson(text: string | null): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Build a cheap, mostly path-based profile. Reads at most two small manifest files. */
export async function profileRepo(snapshot: Snapshot): Promise<Profile> {
  const own = snapshot.paths.filter((p) => !isVendored(p));

  // Languages by file count.
  const counts = new Map<string, number>();
  for (const p of own) {
    const name = basename(p);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const lang = LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const languages = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l]) => l)
    .filter((l) => l !== "shell" || counts.size === 1)
    .slice(0, 5);

  const ecosystems: Profile["ecosystems"] = [];
  for (const [eco, re] of ECOSYSTEM_MANIFESTS) {
    if (own.some((p) => re.test(p))) ecosystems.push(eco);
  }

  const hasDocker = own.some((p) => /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.dockerfile|docker-compose[^/]*\.ya?ml)$/i.test(p));
  const hasWrangler = own.some((p) => /(^|\/)wrangler\.(toml|jsonc?)$/.test(p));
  const hasGithubActions = own.some((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  const hasTypeScript = own.some((p) => /(^|\/)tsconfig[^/]*\.json$/.test(p)) || counts.has("typescript");

  // Root package.json: workspaces, packageManager field, scripts.
  const rootPkg = snapshot.paths.includes("package.json") ? parseJson(await snapshot.read("package.json")) : undefined;

  let packageManager: Profile["packageManager"];
  const pmField = typeof rootPkg?.packageManager === "string" ? rootPkg.packageManager : "";
  const pmMatch = /^(npm|pnpm|yarn|bun)@/.exec(pmField);
  if (pmMatch) packageManager = pmMatch[1] as NonNullable<Profile["packageManager"]>;
  if (!packageManager) {
    for (const [pm, file] of LOCKFILE_PM) {
      if (snapshot.paths.includes(file)) {
        packageManager = pm;
        break;
      }
    }
  }
  if (!packageManager && ecosystems.includes("npm")) packageManager = "npm";

  const manifestsByKind = (re: RegExp) => own.filter((p) => re.test(p) && dirname(p) !== "");
  const monorepo =
    isRecord(rootPkg) && (Array.isArray(rootPkg.workspaces) || isRecord(rootPkg.workspaces)) ||
    own.some((p) => ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "go.work", "rush.json"].includes(p)) ||
    manifestsByKind(/package\.json$/).filter((p) => !/(^|\/)(test|tests|fixtures?|examples?|docs?)\//i.test(p)).length >= 3 ||
    manifestsByKind(/go\.mod$/).length >= 2;

  const commands: Profile["commands"] = {};
  const pm = packageManager ?? "npm";
  if (isRecord(rootPkg) && isRecord(rootPkg.scripts)) {
    const scripts = rootPkg.scripts;
    const run = (name: string) => (pm === "npm" ? `npm run ${name}` : pm === "yarn" ? `yarn ${name}` : `${pm} run ${name}`);
    commands.install = pm === "yarn" ? "yarn install" : `${pm} install`;
    if (typeof scripts.build === "string") commands.build = run("build");
    if (typeof scripts.test === "string" && !/no test specified/.test(scripts.test)) {
      commands.test = pm === "npm" ? "npm test" : run("test");
    }
    if (typeof scripts.lint === "string") commands.lint = run("lint");
    for (const name of ["typecheck", "type-check", "tsc", "check-types"]) {
      if (typeof scripts[name] === "string") {
        commands.typecheck = run(name);
        break;
      }
    }
    for (const name of ["dev", "start"]) {
      if (typeof scripts[name] === "string") {
        commands.dev = run(name);
        break;
      }
    }
  } else if (ecosystems.includes("npm") && snapshot.paths.includes("package.json")) {
    commands.install = `${pm} install`;
  }
  if (ecosystems.includes("go") && snapshot.paths.includes("go.mod")) {
    commands.build ??= "go build ./...";
    commands.test ??= "go test ./...";
    commands.lint ??= own.some((p) => /(^|\/)\.golangci\.ya?ml$/.test(p)) ? "golangci-lint run" : undefined;
  }
  if (ecosystems.includes("cargo") && snapshot.paths.includes("Cargo.toml")) {
    commands.build ??= "cargo build";
    commands.test ??= "cargo test";
  }
  if (ecosystems.includes("python")) {
    if (own.some((p) => /(^|\/)(pytest\.ini|conftest\.py)$/.test(p)) || own.some((p) => /(^|\/)tests?\/.*\.py$/.test(p))) {
      commands.test ??= "pytest";
    }
  }
  for (const k of Object.keys(commands) as Array<keyof Profile["commands"]>) {
    if (commands[k] === undefined) delete commands[k];
  }

  return {
    languages,
    ecosystems,
    packageManager,
    monorepo,
    hasDocker,
    hasWrangler,
    hasGithubActions,
    hasTypeScript,
    fileCount: snapshot.paths.length,
    sizeBucket: sizeBucket(snapshot.paths.length),
    commands
  };
}
