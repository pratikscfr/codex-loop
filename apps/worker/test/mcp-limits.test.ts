import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import {
  MAX_ANALYZING_CALLS_PER_REQUEST,
  MAX_MESSAGES_PER_REQUEST,
  applyMcpCors,
  parseAllowList,
  planMcpCharges,
  rpcIdOf
} from "../src/lib/mcp-limits.ts";
import { evaluateSlidingWindow } from "../src/lib/ratelimit.ts";

const ANALYZING = new Set(["analyze_repository", "get_agent_context"]);
const call = (name: string, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { repo: "a/b" } } });

describe("planMcpCharges: one hit per analyzing tools/call, not per HTTP request", () => {
  it("charges a single call once", () => {
    expect(planMcpCharges(call("analyze_repository"), ANALYZING)).toEqual({ analyzeHits: 1, initializeHits: 0 });
    expect(planMcpCharges(call("get_agent_context"), ANALYZING).analyzeHits).toBe(1);
  });

  it("does not charge cheap tools or other methods", () => {
    expect(planMcpCharges(call("list_controls"), ANALYZING).analyzeHits).toBe(0);
    expect(planMcpCharges(call("explain_control"), ANALYZING).analyzeHits).toBe(0);
    expect(planMcpCharges({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ANALYZING)).toEqual({ analyzeHits: 0, initializeHits: 0 });
    expect(planMcpCharges(undefined, ANALYZING)).toEqual({ analyzeHits: 0, initializeHits: 0 });
    expect(planMcpCharges("garbage", ANALYZING)).toEqual({ analyzeHits: 0, initializeHits: 0 });
  });

  it("charges every analyzing call inside a JSON-RPC batch", () => {
    const batch = [call("analyze_repository", 1), call("list_controls", 2), call("get_agent_context", 3), call("analyze_repository", 4)];
    const plan = planMcpCharges(batch, ANALYZING);
    expect(plan.analyzeHits).toBe(3);
    expect(plan.reject).toBeUndefined();
  });

  it("rejects a batch with more than the allowed number of analyzing calls", () => {
    const batch = Array.from({ length: MAX_ANALYZING_CALLS_PER_REQUEST + 1 }, (_, i) => call("analyze_repository", i));
    const plan = planMcpCharges(batch, ANALYZING);
    expect(plan.reject?.status).toBe(400);
    expect(plan.reject?.rpcCode).toBe(-32600);
    expect(plan.reject?.message).toMatch(/max 3/);
    // a batch of hundreds cannot sneak through on a single hit
    const hundreds = Array.from({ length: 300 }, (_, i) => call("analyze_repository", i));
    expect(planMcpCharges(hundreds, ANALYZING).reject?.status).toBe(400);
    expect(hundreds.length > MAX_MESSAGES_PER_REQUEST).toBe(true);
  });

  it("charges initialize messages separately (session creation)", () => {
    const plan = planMcpCharges({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ANALYZING);
    expect(plan).toEqual({ analyzeHits: 0, initializeHits: 1 });
    expect(planMcpCharges(Array.from({ length: 4 }, (_, i) => ({ method: "initialize", id: i })), ANALYZING).reject?.status).toBe(400);
  });

  it("a weighted hit really consumes N slots of the hourly budget", () => {
    const now = 10 * 3600_000;
    const weight = planMcpCharges([call("analyze_repository", 1), call("analyze_repository", 2), call("analyze_repository", 3)], ANALYZING).analyzeHits;
    // 19 of 20 used: a 3-call batch must be denied even though "one HTTP request" would have fit.
    const used = Array.from({ length: 19 }, (_, i) => now - 1000 - i);
    expect(evaluateSlidingWindow(now, used, 20, 3600_000, weight).allowed).toBe(false);
    expect(evaluateSlidingWindow(now, used, 20, 3600_000, 1).allowed).toBe(true);
  });
});

describe("rpcIdOf", () => {
  it("returns the id of a single message and null for batches / junk", () => {
    expect(rpcIdOf({ id: 7 })).toBe(7);
    expect(rpcIdOf({ id: "abc" })).toBe("abc");
    expect(rpcIdOf([{ id: 1 }])).toBeNull();
    expect(rpcIdOf(undefined)).toBeNull();
    expect(rpcIdOf({ id: {} })).toBeNull();
  });
});

describe("MCP CORS", () => {
  const runtimeHeaders = () =>
    new Headers({
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, mcp-session-id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Expose-Headers": "mcp-session-id",
      "Access-Control-Max-Age": "86400"
    });

  it("strips every CORS header by default (no allow-list)", () => {
    const h = runtimeHeaders();
    applyMcpCors(h, "https://evil.example", []);
    expect([...h.keys()].some((k) => k.startsWith("access-control-"))).toBe(false);
    expect(h.get("content-type")).toBe("text/event-stream");
    const none = runtimeHeaders();
    applyMcpCors(none, null, []);
    expect(none.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes a specific origin only when it is explicitly allow-listed", () => {
    const allowed = runtimeHeaders();
    applyMcpCors(allowed, "https://inspector.example", ["https://inspector.example"]);
    expect(allowed.get("access-control-allow-origin")).toBe("https://inspector.example");
    expect(allowed.get("vary")).toMatch(/Origin/);
    expect(allowed.get("access-control-expose-headers")).toBe("mcp-session-id");

    const denied = runtimeHeaders();
    applyMcpCors(denied, "https://evil.example", ["https://inspector.example"]);
    expect(denied.get("access-control-allow-origin")).toBeNull();
  });

  it("parseAllowList keeps only well-formed origins (no wildcard)", () => {
    expect(parseAllowList(undefined)).toEqual([]);
    expect(parseAllowList("")).toEqual([]);
    expect(parseAllowList("https://a.example, *, http://localhost:3000, javascript:alert(1), https://b.example/path")).toEqual([
      "https://a.example",
      "http://localhost:3000"
    ]);
  });
});
