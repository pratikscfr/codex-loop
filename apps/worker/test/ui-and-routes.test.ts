import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it, expect } from "../../../packages/core/test/testing.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("public/app.js", () => {
  const js = read("../public/app.js");
  const html = read("../public/index.html");

  it("is syntactically valid JavaScript", () => {
    expect(() => new vm.Script(js, { filename: "app.js" })).not.toThrow();
  });

  it("?repo= only pre-fills the input and never auto-runs an analysis", () => {
    const idx = js.indexOf('get("repo")');
    expect(idx).toBeGreaterThan(-1);
    const tail = js.slice(idx);
    expect(tail).toMatch(/els\.input\.value = initial\.slice\(0, 300\)/);
    expect(/analyze\(initial\)/.test(tail)).toBe(false);
    expect(/analyze\(/.test(tail.slice(tail.indexOf("els.input.value")))).toBe(false);
  });

  it("the Add-to-CI snippet points at the action subdirectory with an invalid-until-edited SHA placeholder", () => {
    expect(js).toContain("uses: pratikscfr/codex-loop/action@<full-commit-sha>");
    expect(js.includes("OWNER/codex-loop")).toBe(false);
    expect(js).toMatch(/action\/ subdirectory/);
    expect(html).toContain("&lt;full-commit-sha&gt;");
    expect(html).toMatch(/action\/<\/code> subdirectory/);
  });

  it("chat requests carry a strict per-browser X-Session-Id and never render it from the server", () => {
    expect((js.match(/"x-session-id": sessionId\(\)/g) ?? []).length).toBe(2); // GET history + POST message
    expect(js).toMatch(/\^\[0-9a-f\]\{8\}-/);
    expect(js).toMatch(/localStorage/);
  });

  it("clips repo-derived strings before rendering them", () => {
    for (const expr of ["clip(ev.message)", "clip(r.exception.reason)", "clip(r.note)", "clip(ev.path)"]) {
      expect(js).toContain(expr);
    }
  });

  it("never sends a ref to the API", () => {
    expect(js).toMatch(/JSON\.stringify\(\{ repo: label \}\)/);
    expect(/ref:\s*[^,}]*\bref\b/.test(js.slice(js.indexOf("/api/analyze"), js.indexOf("/api/analyze") + 300))).toBe(false);
  });
});

describe("route ordering (rate limit before any per-repo Durable Object is touched)", () => {
  const routes = read("../src/routes.ts");
  const fn = (name: string, next: string) => routes.slice(routes.indexOf(`async function ${name}(`), next ? routes.indexOf(next) : undefined);

  it("/api/analyze meters the cheap read rule first, then analyze, and only then claims", () => {
    const body = fn("analyze", "// ---- GET /api/analysis/:id");
    const read1 = body.indexOf("RULES.read");
    const agent = body.indexOf("repoAgent(");
    const fresh = body.indexOf("getFreshReport(");
    const analyzeRule = body.indexOf("RULES.analyze");
    const claim = body.indexOf("claimAnalysis(");
    expect(read1).toBeGreaterThan(-1);
    expect(read1 < agent).toBe(true);
    expect(agent < fresh).toBe(true);
    expect(fresh < analyzeRule).toBe(true);
    expect(analyzeRule < claim).toBe(true);
  });

  it("/api/chat (GET and POST) meters the read rule before touching the repo DO; POST then applies the chat rule", () => {
    const history = fn("chatHistory", "async function chat(");
    expect(history.indexOf("RULES.read")).toBeGreaterThan(-1);
    expect(history.indexOf("RULES.read") < history.indexOf("repoAgent(")).toBe(true);
    const post = routes.slice(routes.indexOf("async function chat("));
    expect(post.indexOf("RULES.read") < post.indexOf("repoAgent(")).toBe(true);
    expect(post.indexOf("getReport()") < post.indexOf("RULES.chat")).toBe(true);
    expect(post.indexOf("RULES.chat") < post.indexOf("agent.getChat(")).toBe(true);
  });

  it("report and AGENTS.md reads are metered before the DO too", () => {
    for (const [name, next] of [["report", "// ---- GET /api/agents-md"], ["agentsMd", "// ---- /api/chat"]] as const) {
      const body = fn(name, next);
      expect(body.indexOf("RULES.read") < body.indexOf("repoAgent(")).toBe(true);
    }
  });

  it("the public API no longer forwards a ref anywhere", () => {
    expect(/\bref\b/.test(routes.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/`[^`]*`/g, "").replace(/"[^"]*"/g, ""))).toBe(false);
  });
});

describe("MCP wiring", () => {
  const index = read("../src/index.ts");

  it("charges per billable operation and never sends permissive CORS", () => {
    expect(index).toMatch(/planMcpCharges\(payload, ANALYZING_TOOLS\)/);
    expect(index).toMatch(/enforceLimit\(env, request\.headers, RULES\.analyze, GLOBAL_RULES\.analyze, plan\.analyzeHits\)/);
    expect(index).toMatch(/enforceLimit\(env, request\.headers, RULES\.read, undefined, plan\.initializeHits\)/);
    expect(index).toMatch(/applyMcpCors\(out\.headers,/);
    expect(index.includes('"Access-Control-Allow-Origin"')).toBe(false);
  });

  it("the MCP service path shares the HTTP claim protocol", () => {
    expect(read("../src/service.ts")).toMatch(/resolveReport<Report>\(/);
  });
});
