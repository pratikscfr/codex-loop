import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "../../core/test/testing.ts";
import { main, UsageError } from "../src/main.ts";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-loop-cli-"));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content, "utf8");
  }
  return dir;
}

/** Run main() capturing stdout/stderr so exit codes and output can be asserted. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: await main(argv), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const README = "# fx\n" + "A useful project that does useful things and explains itself. ".repeat(6);
const PKG = JSON.stringify({ name: "fx", scripts: { test: "node --test", build: "tsc" } });

describe("cli exit codes", () => {
  it("exits 1 when an enforced control fails, 0 with --fail-on never, 0 on a clean enforced set", async () => {
    const bad = await fixture({ "package.json": PKG, "README.md": README, ".env": "SECRET=1" });
    try {
      expect((await run(["check", bad])).code).toBe(1);
      expect((await run(["check", bad, "--fail-on", "never"])).code).toBe(0);
      const good = await fixture({ "package.json": PKG, "README.md": README });
      try {
        expect((await run(["check", good])).code).toBe(0); // only warn-mode findings
        expect((await run(["check", good, "--fail-on", "warn"])).code).toBe(1);
      } finally {
        await rm(good, { recursive: true, force: true });
      }
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  it("emits valid JSON and never leaks a secret value", async () => {
    const key = "AKIA" + "QWERTYUIOPASDFGH";
    const dir = await fixture({ "package.json": PKG, "src/a.ts": `export const k = "${key}";\n` });
    try {
      const { out } = await run(["check", dir, "--format", "json", "--fail-on", "never"]);
      const report = JSON.parse(out);
      expect(report.results.length).toBe(20);
      expect(out.includes(key)).toBe(false);
      expect(report.results.find((r: { id: string }) => r.id === "CDX-032").status).toBe("fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad usage with a UsageError instead of a stack trace", async () => {
    await expect(main(["check", ".", "--bogus"])).rejects.toThrow("unknown option");
    await expect(main(["check", ".", "--format", "yaml"])).rejects.toThrow("--format must be one of");
    await expect(main(["check", ".", "--fail-on"])).rejects.toThrow("needs a value");
    await expect(main(["frobnicate"])).rejects.toThrow("unknown command");
    await expect(main(["explain", "CDX-999"])).rejects.toThrow("unknown control");
    await expect(main(["remote", "not a repo"])).rejects.toThrow("remote needs a repository");
    await expect(main(["context", ".", "--max-chars", "5"])).rejects.toThrow("--max-chars");
    let caught: unknown;
    try {
      await main(["nope"]);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof UsageError).toBe(true);
  });

  it("explain and controls work offline", async () => {
    const explain = await run(["explain", "cdx-011"]);
    expect(explain.code).toBe(0);
    expect(explain.out).toContain("pinned");
    const list = await run(["controls"]);
    expect(list.out.split("\n").length).toBe(20);
  });
});

describe("context command", () => {
  it("prints by default, writes with --write, and gates drift with --check", async () => {
    const dir = await fixture({ "package.json": PKG, "README.md": README });
    try {
      const printed = await run(["context", dir]);
      expect(printed.out).toContain("codex-loop:begin");
      expect(await readFile(path.join(dir, "AGENTS.md"), "utf8").catch(() => null)).toBeNull();

      expect((await run(["context", dir, "--check"])).code).toBe(1); // missing
      expect((await run(["context", dir, "--write"])).out).toContain("Created");
      expect((await run(["context", dir, "--check"])).code).toBe(0);

      // Human text outside the block survives regeneration.
      const file = path.join(dir, "AGENTS.md");
      await writeFile(file, "# Mine\n\nKeep this line.\n\n" + (await readFile(file, "utf8")).replace("# AGENTS.md\n\n", ""), "utf8");
      expect((await run(["context", dir, "--write"])).out).toContain("Updated");
      expect(await readFile(file, "utf8")).toContain("Keep this line.");

      // A real change in the repo makes the committed block stale.
      await writeFile(path.join(dir, "tsconfig.json"), "{}", "utf8");
      await writeFile(path.join(dir, "src.ts"), "export {}", "utf8");
      expect((await run(["context", dir, "--check"])).code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write outside the repository", async () => {
    const dir = await fixture({ "package.json": PKG });
    try {
      await expect(main(["context", dir, "--write", "--file", "../escape.md"])).rejects.toThrow("inside the repository");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local snapshot safety", () => {
  it("does not follow symlinks out of the repository", async () => {
    const outside = await fixture({ "secret.txt": "AKIA" + "QWERTYUIOPASDFGH" });
    const dir = await fixture({ "package.json": PKG, "README.md": README });
    try {
      await symlink(path.join(outside, "secret.txt"), path.join(dir, "link.json"));
      const { out } = await run(["check", dir, "--format", "json", "--fail-on", "never"]);
      expect(JSON.parse(out).results.find((r: { id: string }) => r.id === "CDX-032").status).not.toBe("fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
