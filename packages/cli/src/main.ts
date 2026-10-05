import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  analyze,
  analyzeGitHubRepo,
  BLOCK_BEGIN,
  BLOCK_END,
  CONTROLS,
  ENGINE_VERSION,
  failingCount,
  findControl,
  githubAnnotations,
  parseRepoInput,
  renderManagedBlock,
  renderMarkdown,
  renderText,
  upsertManagedBlock,
  type FailOn,
  type Report
} from "@codex-loop/core";
import { createDirectorySnapshot } from "@codex-loop/core/node";

const HELP = `codex-loop ${ENGINE_VERSION}: engineering standards for repos, CI and coding agents

Usage
  codex-loop check [path]            Evaluate the standards against a local repository
  codex-loop context [path]          Print generated agent context (AGENTS.md block)
  codex-loop remote <owner/repo>     Evaluate a public GitHub repository (no clone needed)
  codex-loop controls                List all controls
  codex-loop explain <CDX-000>       Show why a control exists and how to fix it

Options
  --format <text|markdown|json|github>   Output format for check/remote (default: text)
  --fail-on <enforce|warn|never>         Exit 1 on live failures of this mode (default: enforce)
  --verbose                              Also list passing controls
  --write                                context: create or update AGENTS.md in place
  --check                                context: exit 1 if the AGENTS.md block is out of date
  --file <name>                          context: target file (default: AGENTS.md)
  --max-chars <n>                        context: character budget (default: 3500)
  --ref <branch|sha>                     remote: ref to analyze (default: default branch)
  --footprint                            remote: include the pull request footprint
  -h, --help / -v, --version

Environment
  GITHUB_TOKEN   optional; raises GitHub API rate limits for \`remote\`

Exit codes: 0 ok, 1 failing controls (per --fail-on) or stale context (--check), 2 usage or runtime error.
`;

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["format", "fail-on", "file", "max-chars", "ref"]);
const BOOL_FLAGS = new Set(["verbose", "write", "check", "footprint", "help", "version", "h", "v"]);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      const eq = a.indexOf("=");
      const name = (eq === -1 ? a : a.slice(0, eq)).replace(/^-+/, "");
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        flags.set(name, value);
      } else if (BOOL_FLAGS.has(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`unknown option ${a}`);
      }
    } else positional.push(a);
  }
  return { command: positional[0] ?? "", positional: positional.slice(1), flags };
}

export class UsageError extends Error {}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}`);
}

function emit(report: Report, format: string, verbose: boolean): void {
  switch (format) {
    case "json":
      console.log(JSON.stringify(report, null, 2));
      break;
    case "markdown":
      console.log(renderMarkdown(report));
      break;
    case "github":
      for (const line of githubAnnotations(report)) console.log(line);
      console.log(renderText(report, { verbose }));
      break;
    default:
      console.log(renderText(report, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, verbose }));
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has("version") || args.flags.has("v")) {
    console.log(ENGINE_VERSION);
    return 0;
  }
  if (args.flags.has("help") || args.flags.has("h") || !args.command || args.command === "help") {
    console.log(HELP);
    return args.command || args.flags.size ? 0 : 2;
  }

  const format = oneOf(flag(args, "format"), ["text", "markdown", "json", "github"] as const, "text", "format");
  const failOn = oneOf<FailOn>(flag(args, "fail-on"), ["enforce", "warn", "never"], "enforce", "fail-on");
  const verbose = args.flags.has("verbose");

  switch (args.command) {
    case "check": {
      const dir = path.resolve(args.positional[0] ?? ".");
      const report = await analyze(await createDirectorySnapshot(dir));
      report.repo = report.repo ?? { owner: "local", repo: path.basename(dir) };
      emit(report, format, verbose);
      return failingCount(report, failOn) > 0 ? 1 : 0;
    }

    case "remote": {
      const target = args.positional[0];
      const parsed = target ? parseRepoInput(target) : null;
      if (!parsed) throw new UsageError("remote needs a repository such as owner/repo or https://github.com/owner/repo");
      const report = await analyzeGitHubRepo(
        { ...parsed, ref: flag(args, "ref"), includeFootprint: args.flags.has("footprint") },
        { token: process.env.GITHUB_TOKEN }
      );
      emit(report, format, verbose);
      if (format === "text" && report.footprint) {
        console.log("\nPull request footprint (last " + report.footprint.sampled + " closed PRs)");
        for (const b of report.footprint.buckets) console.log(`  ${b.class.padEnd(10)} ${String(b.count).padStart(3)}  median hours to merge: ${b.medianHoursToMerge ?? "n/a"}`);
        console.log("  " + report.footprint.caveat);
      }
      return failingCount(report, failOn) > 0 ? 1 : 0;
    }

    case "context": {
      const dir = path.resolve(args.positional[0] ?? ".");
      const file = path.join(dir, flag(args, "file") ?? "AGENTS.md");
      if (path.relative(dir, file).startsWith("..")) throw new UsageError("--file must be inside the repository");
      const rawMax = flag(args, "max-chars");
      const maxChars = rawMax === undefined ? undefined : Number(rawMax);
      if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 800 || maxChars > 20000)) throw new UsageError("--max-chars must be an integer between 800 and 20000");

      const report = await analyze(await createDirectorySnapshot(dir));
      const block = renderManagedBlock(report, { maxChars });
      const existing = await readIfExists(file);

      if (args.flags.has("check")) {
        const start = existing?.indexOf(BLOCK_BEGIN) ?? -1;
        const end = existing?.indexOf(BLOCK_END) ?? -1;
        const current = existing !== null && start !== -1 && end > start ? existing.slice(start, end + BLOCK_END.length) : null;
        if (current === block) {
          console.log(`${path.relative(process.cwd(), file) || file} is up to date.`);
          return 0;
        }
        console.error(`${path.relative(process.cwd(), file) || file} is ${current === null ? "missing the codex-loop block" : "out of date"}. Run: codex-loop context --write`);
        return 1;
      }
      if (args.flags.has("write")) {
        await writeFile(file, upsertManagedBlock(existing, block), "utf8");
        console.log(`${existing === null ? "Created" : "Updated"} ${path.relative(process.cwd(), file) || file}`);
        return 0;
      }
      console.log(block);
      return 0;
    }

    case "controls": {
      for (const c of CONTROLS) console.log(`${c.id}  ${c.severity.padEnd(8)} ${(c.defaultMode ?? "warn").padEnd(8)} ${c.title}`);
      return 0;
    }

    case "explain": {
      const id = args.positional[0];
      const control = id ? findControl(id) : undefined;
      if (!control) throw new UsageError(`unknown control${id ? ` ${id}` : ""}. Run \`codex-loop controls\` for the list.`);
      console.log(`${control.id}: ${control.title}\nseverity: ${control.severity}   default mode: ${control.defaultMode ?? "warn"}   category: ${control.category}\n\nWhy\n  ${control.rationale}\n\nFix\n  ${control.remediation}\n\nFor coding agents\n  ${control.agentRule}`);
      return 0;
    }

    default:
      throw new UsageError(`unknown command ${JSON.stringify(args.command)}. Try --help.`);
  }
}
