/**
 * A tiny mock of the parts of GitHub that codex-loop reads, for exercising the Worker end to end on a machine
 * that cannot reach raw.githubusercontent.com (for example behind a TLS-intercepting proxy).
 *
 *   node scripts/mock-github.mjs 8913
 *   wrangler dev --local --var GITHUB_API_BASE:http://127.0.0.1:8913/api --var GITHUB_RAW_BASE:http://127.0.0.1:8913/raw
 *   node scripts/smoke.mjs http://127.0.0.1:8787 mock/demo
 *
 * Repos: mock/demo (public, has deliberate problems), mock/private (private: must be refused).
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8913);
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
// Built at runtime so no secret-shaped literal sits in this file.
const FAKE_KEY = ["AKIA", "QWERTYUIOPASDFGH"].join("");

const files = {
  "README.md": "# demo\n" + "A demonstration repository with a few deliberate problems for codex-loop to find. ".repeat(5),
  "package.json": JSON.stringify({ name: "demo", scripts: { build: "tsc", test: "node --test" } }),
  "package-lock.json": "{}",
  ".gitignore": "node_modules\n",
  ".env": "TOKEN=not-a-real-token\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/index.ts": "export const hello = () => 'hi';\n",
  "src/config.ts": `export const key = "${FAKE_KEY}";\n`,
  "Dockerfile": "FROM node:latest\nCMD [\"node\", \"src/index.js\"]\n",
  "wrangler.jsonc": JSON.stringify({ name: "demo", compatibility_date: "2024-01-01", vars: { API_TOKEN: "literal-value-here" } }),
  ".github/workflows/ci.yml": "on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n"
};

const hours = (n) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + n * 3_600_000).toISOString();
const pulls = [
  { number: 1, user: { login: "dependabot[bot]", type: "Bot" }, created_at: hours(0), merged_at: hours(1) },
  { number: 2, user: { login: "copilot-swe-agent[bot]", type: "Bot" }, created_at: hours(0), merged_at: hours(3) },
  { number: 3, user: { login: "alice", type: "User" }, body: "Fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)", created_at: hours(0), merged_at: hours(5) },
  ...[2, 4, 6, 8, 10, 12].map((h, i) => ({ number: 10 + i, user: { login: "bob", type: "User" }, created_at: hours(0), merged_at: hours(h) }))
];

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const p = url.pathname;
  const api = "/api/repos/mock/demo";
  if (p === "/api/repos/mock/private") return json(res, 200, { name: "private", owner: { login: "mock" }, private: true, default_branch: "main", html_url: "https://github.com/mock/private" });
  if (p === api) return json(res, 200, { name: "demo", owner: { login: "mock" }, private: false, default_branch: "main", html_url: "https://github.com/mock/demo" });
  if (p === `${api}/commits/main`) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(SHA);
  }
  if (p === `${api}/git/trees/${SHA}`) {
    return json(res, 200, { sha: SHA, truncated: false, tree: Object.entries(files).map(([path, c]) => ({ path, type: "blob", mode: "100644", size: c.length })) });
  }
  if (p === `${api}/pulls`) return json(res, 200, pulls);
  if (p.startsWith(`/raw/mock/demo/${SHA}/`)) {
    const file = decodeURIComponent(p.slice(`/raw/mock/demo/${SHA}/`.length));
    if (file in files) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(files[file]);
    }
  }
  if (p.startsWith("/api/") || p.startsWith("/raw/")) return json(res, 404, { message: "Not Found" });
  res.writeHead(404).end();
}).listen(port, "127.0.0.1", () => console.log(`mock GitHub on http://127.0.0.1:${port}`));
