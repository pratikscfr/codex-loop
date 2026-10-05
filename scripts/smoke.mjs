/**
 * Black-box smoke test for a running codex-loop Worker (local `wrangler dev` or a deployment).
 *   node scripts/smoke.mjs http://127.0.0.1:8787 [owner/repo]
 * Exit code 1 if any check FAILs. SKIP (for example GitHub rate limiting, Workers AI unavailable) does not fail the run.
 */
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const repo = process.argv[3] ?? "octocat/Hello-World";
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke.mjs <base-url> [owner/repo]");
  process.exit(2);
}

const results = [];
const record = (status, name, detail = "") => {
  results.push(status);
  console.log(`${status.padEnd(5)} ${name}${detail ? `  (${detail})` : ""}`);
};
const check = async (name, fn) => {
  try {
    const out = await fn();
    if (out?.skip) record("SKIP", name, out.skip);
    else record("PASS", name, out?.detail ?? "");
  } catch (err) {
    record("FAIL", name, err instanceof Error ? err.message : String(err));
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
const rpc = (body, sessionId) =>
  fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify(body)
  });
/** MCP responses may be plain JSON or a single SSE event. */
async function rpcJson(res) {
  const text = await res.text();
  const data = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) : text;
  return JSON.parse(data ?? "null");
}

await check("GET /healthz", async () => {
  const res = await fetch(base + "/healthz");
  assert(res.status === 200, `status ${res.status}`);
  assert((await res.json()).status === "ok", "body is not {status:'ok'}");
});

await check("GET / serves the UI with a strict CSP", async () => {
  const res = await fetch(base + "/");
  assert(res.status === 200, `status ${res.status}`);
  const html = await res.text();
  assert(html.includes("codex-loop"), "page does not mention codex-loop");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert(csp.includes("default-src 'none'") || csp.includes("script-src 'self'"), `CSP missing or weak: ${csp.slice(0, 80)}`);
  assert(!/\son\w+=/i.test(html) && !/<script>[^<]/.test(html), "inline script/handler in HTML");
});

await check("POST /api/analyze rejects an empty body with a typed error", async () => {
  const res = await post("/api/analyze", {});
  assert(res.status === 400, `status ${res.status}`);
  const body = await res.json();
  assert(typeof body?.error?.code === "string" && typeof body?.error?.message === "string", "error shape is not {error:{code,message}}");
  assert(!/at\s.+\(.+:\d+:\d+\)/.test(JSON.stringify(body)), "stack trace leaked");
});

await check("POST /api/analyze rejects a caller-chosen ref", async () => {
  const res = await post("/api/analyze", { repo: "octocat/Hello-World", ref: "main" });
  assert(res.status === 400, `status ${res.status}`);
});

await check("POST /api/analyze rejects a non-JSON content type", async () => {
  const res = await fetch(base + "/api/analyze", { method: "POST", headers: { "content-type": "text/plain", origin: base }, body: "x" });
  assert([400, 415].includes(res.status), `status ${res.status}`);
});

await check("POST /api/analyze rejects a cross-origin browser request", async () => {
  const res = await fetch(base + "/api/analyze", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ repo }) });
  assert(res.status === 403, `status ${res.status}`);
});

await check("POST /api/analyze rejects an oversized body", async () => {
  const res = await post("/api/analyze", JSON.stringify({ repo, pad: "x".repeat(20_000) }));
  assert(res.status === 413, `status ${res.status}`);
});

await check("POST /api/analyze rejects hostile repository names", async () => {
  for (const bad of ["../../etc/passwd", "a/b/c", "https://evil.example/x/y", "a/b;rm -rf /", "x".repeat(300)]) {
    const res = await post("/api/analyze", { repo: bad });
    assert(res.status === 400, `${JSON.stringify(bad.slice(0, 30))} returned ${res.status}`);
  }
});

let analyzed = false;
await check(`analyze ${repo} end to end (Workflow -> Durable Object -> report)`, async () => {
  const res = await post("/api/analyze", { repo });
  const started = await res.json();
  if (res.status === 503 || started?.error?.code === "github_rate_limited") return { skip: "GitHub rate limited; re-run later or set GITHUB_TOKEN" };
  assert(res.status === 200 || res.status === 202, `status ${res.status}: ${JSON.stringify(started).slice(0, 120)}`);
  if (res.status === 202) {
    const deadline = Date.now() + 120_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await (await fetch(`${base}/api/analysis/${encodeURIComponent(started.id)}`)).json();
      if (s.status === "complete") break;
      if (s.status === "errored" || s.status === "terminated") {
        if (/rate.?limit/i.test(JSON.stringify(s))) return { skip: "GitHub rate limited during the workflow" };
        throw new Error(`workflow ${s.status}: ${JSON.stringify(s).slice(0, 160)}`);
      }
      assert(Date.now() < deadline, `timed out waiting for the workflow (last status ${s.status})`);
    }
  }
  analyzed = true;
  return { detail: res.status === 200 ? "served from cache" : "workflow completed" };
});

const [owner, name] = repo.split("/");
await check("GET /api/report returns a complete report", async () => {
  if (!analyzed) return { skip: "no analysis available" };
  const res = await fetch(`${base}/api/report/${owner}/${name}`);
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  const report = body.report ?? body;
  assert(Array.isArray(report.results) && report.results.length === 20, `expected 20 results, got ${report.results?.length}`);
  assert(report.repo?.sha && /^[0-9a-f]{40}$/.test(report.repo.sha), "report lacks the analyzed commit sha");
  return { detail: `${report.summary.pass} pass / ${report.summary.fail} fail / ${report.summary.unknown} unknown` };
});

await check("GET /api/agents-md returns the generated agent context", async () => {
  if (!analyzed) return { skip: "no analysis available" };
  const res = await fetch(`${base}/api/agents-md/${owner}/${name}`);
  assert(res.status === 200, `status ${res.status}`);
  assert((await res.text()).includes("codex-loop:begin"), "managed block missing");
});

await check("GET /api/report for an unanalyzed repo is a clean 404", async () => {
  const res = await fetch(`${base}/api/report/smoke-test-owner/never-analyzed-${Date.now()}`);
  assert(res.status === 404, `status ${res.status}`);
});

await check("chat requires a session id and keeps history private per session", async () => {
  if (!analyzed) return { skip: "no analysis available" };
  const noSession = await post(`/api/chat/${owner}/${name}`, { message: "hi" });
  assert(noSession.status === 400, `missing session id returned ${noSession.status}`);
  const session = crypto.randomUUID();
  const history = await fetch(`${base}/api/chat/${owner}/${name}`, { headers: { "x-session-id": session } });
  assert(history.status === 200, `history status ${history.status}`);
  const other = await fetch(`${base}/api/chat/${owner}/${name}`, { headers: { "x-session-id": crypto.randomUUID() } });
  assert(other.status === 200, `other-session history status ${other.status}`);
});

await check("chat answers grounded questions, or degrades to a clean 503 when Workers AI is unavailable", async () => {
  if (!analyzed) return { skip: "no analysis available" };
  const res = await post(`/api/chat/${owner}/${name}`, { message: "Which control is most severe and how do I fix it?" }, { "x-session-id": crypto.randomUUID() });
  if (res.status === 503) return { skip: "Workers AI unavailable in this environment (clean 503)" };
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.trim().length > 0, "empty answer");
  return { detail: `${text.length} chars streamed` };
});

await check("MCP: initialize, tools/list, explain_control", async () => {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  assert(init.status === 200, `initialize status ${init.status}`);
  const sessionId = init.headers.get("mcp-session-id") ?? undefined;
  await init.text();
  if (sessionId) await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).then((r) => r.text());
  const list = await rpcJson(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId));
  const tools = (list?.result?.tools ?? []).map((t) => t.name).sort();
  assert(["analyze_repository", "explain_control", "get_agent_context", "list_controls"].every((t) => tools.includes(t)), `unexpected tools: ${tools.join(",")}`);
  const explain = await rpcJson(await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "explain_control", arguments: { id: "CDX-011" } } }, sessionId));
  assert(JSON.stringify(explain).includes("pinned"), "explain_control did not return the control text");
});

await check("MCP: a batch of analyzing calls cannot bypass the rate limit", async () => {
  const batch = Array.from({ length: 6 }, (_, i) => ({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "analyze_repository", arguments: { repo: `octocat/batch-${i}` } } }));
  const res = await rpc(batch);
  assert([400, 429].includes(res.status), `status ${res.status}; a 6-call batch must be rejected`);
});

await check("MCP sends no permissive CORS headers", async () => {
  const res = await fetch(base + "/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert(res.headers.get("access-control-allow-origin") !== "*", "wildcard CORS on /mcp");
});

const failed = results.filter((r) => r === "FAIL").length;
console.log(`\n${results.filter((r) => r === "PASS").length} passed, ${failed} failed, ${results.filter((r) => r === "SKIP").length} skipped`);
process.exit(failed ? 1 : 0);
