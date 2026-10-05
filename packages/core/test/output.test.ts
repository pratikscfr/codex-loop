import { describe, expect, it } from "./testing.ts";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  classifyPullRequest,
  githubAnnotations,
  renderAgentsMd,
  renderManagedBlock,
  renderMarkdown,
  renderText,
  summarizeFootprint,
  upsertManagedBlock,
  type Report
} from "../src/index.ts";
import { LONG_README, NOW, run } from "./helpers.ts";
import { parseJsonc, stripJsonComments } from "../src/util.ts";

const PKG = JSON.stringify({ name: "x", scripts: { test: "vitest", build: "tsc", lint: "eslint ." } });

async function sampleReport(): Promise<Report> {
  return run({ "package.json": PKG, "pnpm-lock.yaml": "x", "README.md": LONG_README, "src/a.ts": "export {}", "tsconfig.json": "{}" });
}

describe("agent context (AGENTS.md)", () => {
  it("includes discovered commands and marks violated rules", async () => {
    const md = renderAgentsMd(await sampleReport());
    expect(md).toContain("`pnpm run build`");
    expect(md).toContain("`pnpm run lint`");
    expect(md).toContain(BLOCK_BEGIN);
    expect(md).toContain(BLOCK_END);
    expect(md).toContain("**(violated today)**");
    expect(md).toContain("CDX-060"); // strict TS is not enabled in the sample
  });

  it("respects the character budget by dropping the lowest-severity rules first", async () => {
    const r = await sampleReport();
    const small = renderManagedBlock(r, { maxChars: 1200 });
    const large = renderManagedBlock(r, { maxChars: 8000 });
    expect(small.length).toBeLessThanOrEqual(1300);
    expect(small.length < large.length).toBe(true);
    expect(small).toContain("omitted to stay within the context budget");
    expect(small).toContain(BLOCK_END);
    // the most severe applicable rule survives truncation
    const firstRule = large.split("\n").find((l) => l.startsWith("- **CDX-"))!;
    expect(small).toContain(firstRule);
  });

  it("is deterministic (no timestamps) so CI regeneration produces no diff", async () => {
    expect(renderAgentsMd(await sampleReport())).toBe(renderAgentsMd(await sampleReport()));
  });

  it("upsert preserves human content and is idempotent", async () => {
    const block = renderManagedBlock(await sampleReport());
    const human = "# My AGENTS.md\n\nAlways say hello.\n";
    const once = upsertManagedBlock(human, block);
    expect(once).toContain("Always say hello.");
    expect(once).toContain(BLOCK_BEGIN);
    const twice = upsertManagedBlock(once, block);
    expect(twice).toBe(once);
    const edited = once.replace("Always say hello.", "Always say goodbye.");
    expect(upsertManagedBlock(edited, block)).toContain("Always say goodbye.");
    expect(upsertManagedBlock(null, block)).toContain("# AGENTS.md");
  });
});

describe("renderers", () => {
  it("markdown escapes repo-derived text so a filename cannot inject markup", async () => {
    const r = await run({
      "package.json": PKG,
      '.github/workflows/<img src=x onerror=alert(1)>|evil.yml': "jobs:\n  a:\n    steps:\n      - uses: a/b@v1\n"
    });
    const md = renderMarkdown(r, { marker: true });
    expect(md.startsWith("<!-- codex-loop:report -->")).toBe(true);
    // Repo-controlled names may only appear inside inline code spans, where markdown renders them literally.
    const outsideCode = md.replace(/`[^`\n]*`/g, "");
    expect(outsideCode).not.toContain("<img");
    expect(outsideCode).not.toContain("onerror");
    expect(md).toContain("`.github/workflows/<img");
  });

  it("markdown contains failing controls with fixes; text output has no ANSI unless asked", async () => {
    const r = await sampleReport();
    const md = renderMarkdown(r);
    expect(md).toContain("### Failing");
    expect(md).toContain("Fix:");
    expect(renderText(r)).not.toContain("\x1b[");
    expect(renderText(r, { color: true })).toContain("\x1b[");
  });

  it("github annotations use the right level per mode and escape newlines and separators", async () => {
    const r = await run({ "package.json": "{}", ".env": "A=1", "README.md": LONG_README });
    const lines = githubAnnotations(r);
    expect(lines.some((l) => l.startsWith("::error ") && l.includes("CDX-031"))).toBe(true);
    expect(lines.some((l) => l.startsWith("::warning "))).toBe(true);
    for (const l of lines) {
      expect(l.includes("\n")).toBe(false);
      expect(l).toMatch(/^::(error|warning|notice) /);
    }
    const tricky = { ...r, results: r.results.map((x) => (x.id === "CDX-031" ? { ...x, evidence: [{ path: "a,b:c", line: 2, message: "line1\nline2 100%" }] } : x)) };
    const a = githubAnnotations(tricky).find((l) => l.includes("CDX-031"))!;
    expect(a).toContain("file=a%2Cb%3Ac");
    expect(a).toContain("line1%0Aline2 100%25");
  });
});

describe("pull request footprint", () => {
  const base = { created_at: "2026-09-01T00:00:00Z", merged_at: "2026-09-01T10:00:00Z" };

  it("classifies by identity, branch, text markers and labels, with evidence", () => {
    expect(classifyPullRequest({ number: 1, user: { login: "dependabot[bot]", type: "Bot" }, ...base }).class).toBe("automation");
    expect(classifyPullRequest({ number: 2, user: { login: "copilot-swe-agent[bot]", type: "Bot" }, ...base }).class).toBe("ai-agent");
    expect(classifyPullRequest({ number: 3, user: { login: "alice", type: "User" }, head: { ref: "claude/fix-login" }, ...base }).class).toBe("ai-agent");
    const assisted = classifyPullRequest({ number: 4, user: { login: "bob", type: "User" }, body: "Fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)", ...base });
    expect(assisted.class).toBe("ai-signal");
    expect(assisted.evidence.length).toBeGreaterThan(0);
    expect(classifyPullRequest({ number: 5, user: { login: "carol", type: "User" }, labels: [{ name: "ai-generated" }], ...base }).class).toBe("ai-signal");
    expect(classifyPullRequest({ number: 6, user: { login: "dave", type: "User" }, body: "plain", ...base }).class).toBe("no-signal");
  });

  it("does not treat a human named like an agent as an agent", () => {
    expect(classifyPullRequest({ number: 7, user: { login: "cursor", type: "User" }, ...base }).class).toBe("no-signal");
    expect(classifyPullRequest({ number: 8, user: { login: "claude", type: "User" }, body: "x", ...base }).class).toBe("no-signal");
  });

  it("computes hours to merge and tolerates bad timestamps", () => {
    expect(classifyPullRequest({ number: 1, created_at: "2026-09-01T00:00:00Z", merged_at: "2026-09-01T03:30:00Z" }).hoursToMerge).toBe(3.5);
    expect(classifyPullRequest({ number: 1, created_at: "garbage", merged_at: null }).hoursToMerge).toBeNull();
    expect(classifyPullRequest({ number: 1, created_at: "2026-09-02T00:00:00Z", merged_at: "2026-09-01T00:00:00Z" }).hoursToMerge).toBeNull();
  });

  it("suppresses medians below the minimum sample and always carries the caveat", () => {
    const prs = Array.from({ length: 6 }, (_, i) => ({
      number: i,
      user: { login: "h", type: "User" },
      created_at: "2026-09-01T00:00:00Z",
      merged_at: `2026-09-01T0${i}:00:00Z`
    }));
    const agents = [1, 2].map((n) => ({ number: 100 + n, user: { login: "copilot-swe-agent[bot]", type: "Bot" }, ...base }));
    const f = summarizeFootprint([...prs, ...agents], NOW);
    const human = f.buckets.find((b) => b.class === "no-signal")!;
    const agent = f.buckets.find((b) => b.class === "ai-agent")!;
    expect(human.count).toBe(6);
    expect(human.medianHoursToMerge).toBe(2.5);
    expect(agent.count).toBe(2);
    expect(agent.medianHoursToMerge).toBeNull();
    expect(f.caveat).toContain("lower bound");
    expect(f.sampled).toBe(8);
  });
});

describe("jsonc helpers", () => {
  it("strips comments and trailing commas but keeps URLs and comment-like strings", () => {
    const text = '{\n // c\n "url": "http://x/y", /* b */ "s": "a // not /* a comment */", "arr": [1,2,],\n}';
    expect(parseJsonc(text)).toEqual({ url: "http://x/y", s: "a // not /* a comment */", arr: [1, 2] });
    expect(parseJsonc("{bad")).toBeUndefined();
    expect(parseJsonc('\ufeff{"a":1}')).toEqual({ a: 1 });
    expect(stripJsonComments('{"a":"\\" // still string"}')).toContain('// still string');
  });
});

describe("agent context is a fixed point", () => {
  it("the block does not change when the agent context file it lives in appears", async () => {
    const files = { "package.json": PKG, "README.md": LONG_README };
    const before = renderManagedBlock(await run(files));
    const after = renderManagedBlock(await run({ ...files, "AGENTS.md": before }));
    expect(after).toBe(before);
  });
});
