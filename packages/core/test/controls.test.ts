import { describe, expect, it } from "./testing.ts";
import { get, LONG_README, run } from "./helpers.ts";

const PKG = JSON.stringify({ name: "x", scripts: { test: "vitest", build: "tsc" } });

describe("hygiene controls", () => {
  it("CDX-001 README: missing, too short, ok", async () => {
    expect(get(await run({ "package.json": PKG }), "CDX-001").status).toBe("fail");
    expect(get(await run({ "README.md": "# hi" }), "CDX-001").status).toBe("fail");
    expect(get(await run({ "README.md": LONG_README }), "CDX-001").status).toBe("pass");
    expect(get(await run({ readme: LONG_README }), "CDX-001").status).toBe("pass");
  });

  it("CDX-002 CODEOWNERS: absent, empty, present", async () => {
    expect(get(await run({ "README.md": "x" }), "CDX-002").status).toBe("fail");
    expect(get(await run({ ".github/CODEOWNERS": "# only a comment\n\n" }), "CDX-002").status).toBe("fail");
    expect(get(await run({ ".github/CODEOWNERS": "* @org/team\n" }), "CDX-002").status).toBe("pass");
  });

  it("CDX-003/004 security policy and license", async () => {
    const bare = await run({ "README.md": "x" });
    expect(get(bare, "CDX-003").status).toBe("fail");
    expect(get(bare, "CDX-004").status).toBe("fail");
    const ok = await run({ "SECURITY.md": "x", "LICENSE": "MIT" });
    expect(get(ok, "CDX-003").status).toBe("pass");
    expect(get(ok, "CDX-004").status).toBe("pass");
  });

  it("CDX-070 agent context: detects several conventions", async () => {
    expect(get(await run({ "package.json": PKG }), "CDX-070").status).toBe("fail");
    for (const f of ["AGENTS.md", "CLAUDE.md", ".cursor/rules/a.mdc", ".github/copilot-instructions.md"]) {
      expect(get(await run({ "package.json": PKG, [f]: "x" }), "CDX-070").status).toBe("pass");
    }
  });
});

describe("CI controls", () => {
  it("CDX-010 CI configured (not applicable without ecosystems)", async () => {
    expect(get(await run({ "notes.txt": "x" }), "CDX-010").status).toBe("na");
    expect(get(await run({ "package.json": PKG }), "CDX-010").status).toBe("fail");
    expect(get(await run({ "package.json": PKG, ".gitlab-ci.yml": "x: 1" }), "CDX-010").status).toBe("pass");
  });

  it("CDX-011 flags tags and branches, accepts SHAs, local and docker refs", async () => {
    const sha = "a".repeat(40);
    const wf = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - uses: actions/setup-node@${sha} # v4`,
      "      - uses: ./local-action",
      "      - uses: docker://alpine:3",
      "      # - uses: commented/out@v1",
      "      - uses: owner/repo/.github/workflows/x.yml@main"
    ].join("\n");
    const r = get(await run({ ".github/workflows/ci.yml": wf }), "CDX-011");
    expect(r.status).toBe("fail");
    const messages = r.evidence.map((e) => e.message).join("\n");
    expect(messages).toContain("actions/checkout@v4");
    expect(messages).toContain("owner/repo/.github/workflows/x.yml@main");
    expect(messages).not.toContain("setup-node");
    expect(messages).not.toContain("commented/out");
    expect(r.evidence[0]?.line).toBe(4);

    const good = `jobs:\n  b:\n    steps:\n      - uses: actions/checkout@${sha}\n`;
    expect(get(await run({ ".github/workflows/ci.yml": good }), "CDX-011").status).toBe("pass");
  });

  it("CDX-012 permissions: top-level, per-job, write-all, missing", async () => {
    const top = "permissions:\n  contents: read\njobs:\n  a:\n    steps: []\n";
    const perJob = "jobs:\n  a:\n    permissions: { contents: read }\n    steps: []\n  b:\n    permissions: {}\n    steps: []\n";
    const partial = "jobs:\n  a:\n    permissions: { contents: read }\n    steps: []\n  b:\n    steps: []\n";
    const none = "jobs:\n  a:\n    steps: []\n";
    const writeAll = "permissions: write-all\njobs:\n  a:\n    steps: []\n";
    expect(get(await run({ ".github/workflows/a.yml": top }), "CDX-012").status).toBe("pass");
    expect(get(await run({ ".github/workflows/a.yml": perJob }), "CDX-012").status).toBe("pass");
    expect(get(await run({ ".github/workflows/a.yml": partial }), "CDX-012").status).toBe("fail");
    expect(get(await run({ ".github/workflows/a.yml": none }), "CDX-012").status).toBe("fail");
    expect(get(await run({ ".github/workflows/a.yml": writeAll }), "CDX-012").status).toBe("fail");
  });

  it("CDX-012 unparseable workflow is unknown, not a crash", async () => {
    const r = get(await run({ ".github/workflows/a.yml": "jobs: [unclosed\n  - : :" }), "CDX-012");
    expect(r.status).toBe("unknown");
  });
});

describe("supply chain controls", () => {
  it("CDX-020 npm lockfile in dir, in parent (workspaces), or missing", async () => {
    expect(get(await run({ "package.json": PKG }), "CDX-020").status).toBe("fail");
    expect(get(await run({ "package.json": PKG, "package-lock.json": "{}" }), "CDX-020").status).toBe("pass");
    expect(get(await run({ "package.json": PKG, "packages/a/package.json": PKG, "pnpm-lock.yaml": "x" }), "CDX-020").status).toBe("pass");
    expect(get(await run({ "api/package.json": PKG }), "CDX-020").status).toBe("fail");
  });

  it("CDX-020 ignores fixtures/examples and node_modules", async () => {
    const r = await run({ "package.json": PKG, "yarn.lock": "x", "examples/demo/package.json": PKG, "node_modules/foo/package.json": PKG });
    expect(get(r, "CDX-020").status).toBe("pass");
  });

  it("CDX-020 go.sum required only when go.mod has requirements", async () => {
    expect(get(await run({ "go.mod": "module x\n\ngo 1.22\n" }), "CDX-020").status).toBe("pass");
    expect(get(await run({ "go.mod": "module x\n\nrequire github.com/a/b v1.0.0\n" }), "CDX-020").status).toBe("fail");
    expect(get(await run({ "go.mod": "module x\n\nrequire github.com/a/b v1.0.0\n", "go.sum": "x" }), "CDX-020").status).toBe("pass");
  });

  it("CDX-020 cargo without Cargo.lock is unknown (libraries may omit)", async () => {
    expect(get(await run({ "Cargo.toml": "[package]\nname='x'" }), "CDX-020").status).toBe("unknown");
    expect(get(await run({ "Cargo.toml": "[package]", "Cargo.lock": "x" }), "CDX-020").status).toBe("pass");
  });

  it("CDX-021 dependency bot config", async () => {
    expect(get(await run({ "package.json": PKG }), "CDX-021").status).toBe("fail");
    expect(get(await run({ "package.json": PKG, ".github/dependabot.yml": "version: 2" }), "CDX-021").status).toBe("pass");
    expect(get(await run({ "package.json": JSON.stringify({ renovate: { extends: ["config:base"] } }) }), "CDX-021").status).toBe("pass");
  });
});

describe("secrets controls", () => {
  it("CDX-030 .gitignore env rules", async () => {
    expect(get(await run({ "package.json": PKG }), "CDX-030").status).toBe("fail");
    expect(get(await run({ "package.json": PKG, ".gitignore": "node_modules\n" }), "CDX-030").status).toBe("fail");
    for (const rule of [".env", ".env*", ".env.*", ".env.local", "/.env", "*.env", "**/.env"]) {
      expect(get(await run({ "package.json": PKG, ".gitignore": `${rule}\n` }), "CDX-030").status, rule).toBe("pass");
    }
    // negations and comments do not count
    expect(get(await run({ "package.json": PKG, ".gitignore": "# .env\n!.env\n" }), "CDX-030").status).toBe("fail");
  });

  it("CDX-030 wrangler projects must also ignore .dev.vars", async () => {
    const files = { "wrangler.jsonc": "{}", ".gitignore": ".env\n" };
    expect(get(await run(files), "CDX-030").status).toBe("fail");
    expect(get(await run({ ...files, ".gitignore": ".env\n.dev.vars\n" }), "CDX-030").status).toBe("pass");
  });

  it("CDX-031 flags tracked credential files, allows templates", async () => {
    const r = get(await run({ ".env": "A=1", ".env.local": "A=1", ".env.example": "A=", ".env.development.local": "A=1", ".dev.vars": "A=1", "keys/id_rsa": "x", "ci/app.keystore": "x" }), "CDX-031");
    expect(r.status).toBe("fail");
    const paths = r.evidence.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining([".env", ".env.local", ".env.development.local", ".dev.vars", "keys/id_rsa", "ci/app.keystore"]));
    expect(paths).not.toContain(".env.example");
    expect(get(await run({ ".env.example": "A=", ".env.development": "PORT=1", "README.md": "x" }), "CDX-031").status).toBe("pass");
  });

  it("CDX-032 finds real-looking secrets, hides values, ignores placeholders and test paths", async () => {
    const awsKey = "AKIA" + "QWERTYUIOPASDFGH"; // 20 chars, high variety
    const r = get(
      await run({
        "src/config.ts": `const k = "${awsKey}";\n`,
        "src/example.ts": 'const k = "AKIAXXXXXXXXXXXXXXXX";\n',
        "src/doc.ts": 'const k = "AKIAIOSFODNN7EXAMPLE";\n',
        "test/fixture.ts": `const k = "${awsKey}";\n`,
        "key.pem.json": '{"k":"-----BEGIN RSA PRIVATE KEY-----"}'
      }),
      "CDX-032"
    );
    expect(r.status).toBe("fail");
    const text = JSON.stringify(r.evidence);
    expect(text).not.toContain(awsKey);
    expect(text).toContain("AWS access key ID");
    expect(text).toContain("private key block");
    expect(r.evidence.find((e) => e.path === "src/config.ts")?.line).toBe(1);
    expect(r.evidence.some((e) => e.path?.startsWith("test/"))).toBe(false);
    expect(r.evidence.some((e) => e.path === "src/example.ts" || e.path === "src/doc.ts")).toBe(false);
  });

  it("CDX-032 reports unknown (not a clean pass) when the read budget covers under half the files", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`src/f${i}.ts`] = "export const a = 1;\n";
    const r = get(await run(files, { maxFileReads: 4 }), "CDX-032");
    expect(r.status).toBe("unknown");
    const full = get(await run(files), "CDX-032");
    expect(full.status).toBe("pass");
  });
});

describe("container controls", () => {
  it("CDX-040 base image tags", async () => {
    const bad = "FROM node\nFROM ubuntu:latest AS a\nFROM a\nFROM scratch\nFROM --platform=linux/amd64 python:3.12-slim\nFROM ${BASE}\n";
    const r = get(await run({ Dockerfile: bad }), "CDX-040");
    expect(r.status).toBe("fail");
    expect(r.evidence.map((e) => e.line)).toEqual([1, 2]);
    expect(get(await run({ Dockerfile: "FROM node:22-alpine\nFROM gcr.io/x/y@sha256:" + "a".repeat(64) + "\n" }), "CDX-040").status).toBe("pass");
    expect(get(await run({ Dockerfile: "FROM localhost:5000/app\n" }), "CDX-040").status).toBe("fail");
    expect(get(await run({ Dockerfile: "FROM localhost:5000/app:1.2\n" }), "CDX-040").status).toBe("pass");
  });

  it("CDX-041 non-root USER in the final stage", async () => {
    expect(get(await run({ Dockerfile: "FROM node:22\nRUN x\n" }), "CDX-041").status).toBe("fail");
    expect(get(await run({ Dockerfile: "FROM node:22\nUSER root\n" }), "CDX-041").status).toBe("fail");
    expect(get(await run({ Dockerfile: "FROM node:22 AS build\nUSER node\nFROM node:22\nRUN x\n" }), "CDX-041").status).toBe("fail");
    expect(get(await run({ Dockerfile: "FROM node:22\nUSER node\n" }), "CDX-041").status).toBe("pass");
    expect(get(await run({ Dockerfile: "FROM node:22\nUSER 1000:1000\n" }), "CDX-041").status).toBe("pass");
    expect(get(await run({ Dockerfile: "FROM node:22\nARG U\nUSER $U\n" }), "CDX-041").status).toBe("unknown");
    expect(get(await run({ Dockerfile: "FROM node:22\nRUN apt-get install \\\n  curl\nUSER app\n" }), "CDX-041").status).toBe("pass");
  });
});

describe("cloudflare controls", () => {
  it("CDX-050 compatibility_date age (JSONC and TOML)", async () => {
    const fresh = '{ // comment\n "compatibility_date": "2026-06-11", }';
    const stale = '{"compatibility_date": "2024-01-01"}';
    const missing = '{"name": "w"}';
    expect(get(await run({ "wrangler.jsonc": fresh }), "CDX-050").status).toBe("pass");
    expect(get(await run({ "wrangler.jsonc": stale }), "CDX-050").status).toBe("fail");
    expect(get(await run({ "wrangler.json": missing }), "CDX-050").status).toBe("fail");
    expect(get(await run({ "wrangler.toml": 'name = "w"\ncompatibility_date = "2026-06-11" # ok\n' }), "CDX-050").status).toBe("pass");
    expect(get(await run({ "wrangler.toml": 'compatibility_date = "2023-05-01"\n' }), "CDX-050").status).toBe("fail");
    expect(get(await run({ "wrangler.jsonc": "{not json" }), "CDX-050").status).toBe("unknown");
    expect(get(await run({ "wrangler.jsonc": '{"compatibility_date": "2030-01-01"}' }), "CDX-050").status).toBe("unknown");
  });

  it("CDX-051 observability", async () => {
    expect(get(await run({ "wrangler.jsonc": '{"observability":{"enabled":true}}' }), "CDX-051").status).toBe("pass");
    expect(get(await run({ "wrangler.jsonc": "{}" }), "CDX-051").status).toBe("fail");
    expect(get(await run({ "wrangler.toml": "[observability]\nenabled = true\n" }), "CDX-051").status).toBe("pass");
    expect(get(await run({ "wrangler.toml": "observability = { enabled = true }\n" }), "CDX-051").status).toBe("pass");
  });

  it("CDX-052 literal secrets in vars, including per-environment, never echoing the value", async () => {
    const cfg = '{"vars":{"API_TOKEN":"sk-super-secret-value","PUBLIC_URL":"https://x.dev","TOKEN_URL":"https://auth.example.com","DEBUG":"true"},"env":{"prod":{"vars":{"DB_PASSWORD":"hunter2hunter2"}}}}';
    const r = get(await run({ "wrangler.jsonc": cfg }), "CDX-052");
    expect(r.status).toBe("fail");
    const text = JSON.stringify(r.evidence);
    expect(text).toContain("vars.API_TOKEN");
    expect(text).toContain("env.prod.vars.DB_PASSWORD");
    expect(text).not.toContain("sk-super-secret-value");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("PUBLIC_URL");
    expect(text).not.toContain("TOKEN_URL");
    const toml = '[vars]\nAPI_KEY = "abc123secretvalue"\nNAME = "x"\n';
    expect(get(await run({ "wrangler.toml": toml }), "CDX-052").status).toBe("fail");
    expect(get(await run({ "wrangler.toml": '[vars]\nAPI_KEY = ""\nNAME = "x"\n' }), "CDX-052").status).toBe("pass");
    expect(get(await run({ "wrangler.jsonc": '{"vars":{"API_KEY":"<your-key>"}}' }), "CDX-052").status).toBe("pass");
  });
});

describe("quality controls", () => {
  const TS = { "src/a.ts": "export {}" };
  it("CDX-060 strict directly, via relative extends, via @tsconfig base, via references", async () => {
    expect(get(await run({ ...TS, "tsconfig.json": '{"compilerOptions":{"strict":true}}' }), "CDX-060").status).toBe("pass");
    expect(get(await run({ ...TS, "tsconfig.json": '{"compilerOptions":{"strict":false}}' }), "CDX-060").status).toBe("fail");
    expect(get(await run({ ...TS, "tsconfig.json": '{"compilerOptions":{}}' }), "CDX-060").status).toBe("fail");
    expect(get(await run({ ...TS, "tsconfig.json": '{"extends":"./base.json"}', "base.json": '{"compilerOptions":{"strict":true}}' }), "CDX-060").status).toBe("pass");
    expect(get(await run({ ...TS, "tsconfig.json": '{"extends":"@tsconfig/node20/tsconfig.json"}' }), "CDX-060").status).toBe("pass");
    expect(get(await run({ ...TS, "tsconfig.json": '{"extends":"some-company-config"}' }), "CDX-060").status).toBe("unknown");
    const solution = { ...TS, "tsconfig.json": '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}', "tsconfig.app.json": '{"compilerOptions":{"strict":true}}' };
    expect(get(await run(solution), "CDX-060").status).toBe("pass");
    expect(get(await run({ ...solution, "tsconfig.app.json": "{}" }), "CDX-060").status).toBe("fail");
  });

  it("CDX-060 handles extends cycles and escapes without hanging", async () => {
    const cyc = { ...TS, "tsconfig.json": '{"extends":"./a.json"}', "a.json": '{"extends":"./tsconfig.json"}' };
    expect(["unknown", "fail"]).toContain(get(await run(cyc), "CDX-060").status);
    expect(get(await run({ ...TS, "tsconfig.json": '{"extends":"../../outside.json"}' }), "CDX-060").status).toBe("unknown");
  });

  it("CDX-061 tests exist across ecosystems", async () => {
    expect(get(await run({ "package.json": JSON.stringify({ name: "x" }) }), "CDX-061").status).toBe("fail");
    expect(get(await run({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) }), "CDX-061").status).toBe("pass");
    expect(get(await run({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), "CDX-061").status).toBe("fail");
    expect(get(await run({ "go.mod": "module x", "pkg/a_test.go": "x" }), "CDX-061").status).toBe("pass");
    expect(get(await run({ "pyproject.toml": "[project]", "tests/test_a.py": "x" }), "CDX-061").status).toBe("pass");
    expect(get(await run({ "package.json": "{}", "src/a.test.ts": "x" }), "CDX-061").status).toBe("pass");
  });
});
