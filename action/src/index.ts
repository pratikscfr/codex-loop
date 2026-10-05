import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analyze,
  BLOCK_BEGIN,
  BLOCK_END,
  COMMENT_MARKER,
  failingCount,
  githubAnnotations,
  renderManagedBlock,
  renderMarkdown,
  renderText,
  type FailOn,
  type Report
} from "@codex-loop/core";
import { createDirectorySnapshot } from "@codex-loop/core/node";

/** GitHub passes action inputs as INPUT_<NAME> environment variables. */
function input(name: string, fallback = ""): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? fallback).trim();
}

function warn(message: string): void {
  console.log(`::warning::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
}

async function setOutput(name: string, value: string): Promise<void> {
  const file = process.env.GITHUB_OUTPUT;
  if (file) await appendFile(file, `${name}=${value}\n`);
}

/** The pull request number from the event payload, if this run is for a pull request. */
async function pullRequestNumber(): Promise<number | null> {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file) return null;
  try {
    const event = JSON.parse(await readFile(file, "utf8")) as { pull_request?: { number?: number } };
    return event.pull_request?.number ?? null;
  } catch {
    return null;
  }
}

/** Create or update one comment identified by a hidden marker. Failures (fork PRs, missing scope) only warn. */
async function upsertComment(body: string): Promise<void> {
  const token = input("github-token");
  const repo = process.env.GITHUB_REPOSITORY;
  const number = await pullRequestNumber();
  if (!token || !repo || number === null) return;
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "codex-loop-action",
    "x-github-api-version": "2022-11-28"
  };
  try {
    const list = await fetch(`${api}/repos/${repo}/issues/${number}/comments?per_page=100`, { headers });
    if (!list.ok) throw new Error(`listing comments returned ${list.status}`);
    const comments = (await list.json()) as Array<{ id: number; body?: string }>;
    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    const res = existing
      ? await fetch(`${api}/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) })
      : await fetch(`${api}/repos/${repo}/issues/${number}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
    if (!res.ok) throw new Error(`writing the comment returned ${res.status}`);
  } catch (err) {
    warn(`codex-loop could not post the pull request comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkContext(dir: string, report: Report): Promise<boolean> {
  const file = path.join(dir, "AGENTS.md");
  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch {
    /* missing is reported below */
  }
  const block = renderManagedBlock(report);
  const start = existing?.indexOf(BLOCK_BEGIN) ?? -1;
  const end = existing?.indexOf(BLOCK_END) ?? -1;
  const current = existing !== null && start !== -1 && end > start ? existing.slice(start, end + BLOCK_END.length) : null;
  if (current === block) return true;
  console.log(`::error file=AGENTS.md::${current === null ? "AGENTS.md is missing the codex-loop block" : "The codex-loop block in AGENTS.md is out of date"}. Run: npx codex-loop context --write`);
  return false;
}

async function main(): Promise<number> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const dir = path.resolve(workspace, input("path", "."));
  if (path.relative(workspace, dir).startsWith("..")) throw new Error("path must be inside the workspace");
  const failOnRaw = input("fail-on", "enforce");
  if (!["enforce", "warn", "never"].includes(failOnRaw)) throw new Error("fail-on must be enforce, warn or never");
  const failOn = failOnRaw as FailOn;

  const report = await analyze(await createDirectorySnapshot(dir));
  const repo = process.env.GITHUB_REPOSITORY?.split("/");
  if (repo?.length === 2) report.repo = { owner: repo[0]!, repo: repo[1]!, sha: process.env.GITHUB_SHA };

  for (const line of githubAnnotations(report)) console.log(line);
  console.log(renderText(report));

  const tmp = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "codex-loop-"));
  const jsonPath = path.join(tmp, "report.json");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const markdown = renderMarkdown(report, { marker: true });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  if (input("comment", "false") === "true") await upsertComment(markdown);

  const failing = failingCount(report, failOn);
  await setOutput("failing", String(failing));
  await setOutput("report-json", jsonPath);

  let ok = failing === 0;
  if (input("check-context", "false") === "true" && !(await checkContext(dir, report))) ok = false;
  if (!ok) console.log(`::error::codex-loop: ${failing} failing control(s) counted against fail-on=${failOn}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.log(`::error::codex-loop failed to run: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
);
