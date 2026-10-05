import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import { ApiError } from "../src/lib/errors.ts";
import { resolveReport, type ResolveDeps } from "../src/lib/claim.ts";
import type { ClaimResult } from "../src/lib/types.ts";

/** A tiny in-memory stand-in for the RepoAgent claim protocol (same semantics as claimAnalysis). */
function fakeAgent() {
  const state = { report: null as string | null, inflight: null as string | null, analyses: 0, released: [] as string[] };
  const deps = (opts: { analyzeMs?: number; fail?: boolean } = {}): ResolveDeps<string> => ({
    async claim(id): Promise<ClaimResult<string>> {
      if (state.report) return { kind: "cached", report: state.report };
      if (state.inflight) return { kind: "inflight", id: state.inflight };
      state.inflight = id;
      return { kind: "claimed" };
    },
    async analyze() {
      state.analyses++;
      await new Promise((r) => setTimeout(r, opts.analyzeMs ?? 5));
      if (opts.fail) throw new Error("github exploded");
      return "report-v1";
    },
    async save(report, id) {
      state.report = report;
      if (state.inflight === id) state.inflight = null;
      return report;
    },
    async release(id) {
      state.released.push(id);
      if (state.inflight === id) state.inflight = null;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    now: () => Date.now(),
    newId: () => Math.random().toString(16).slice(2)
  });
  return { state, deps };
}

describe("resolveReport (MCP cache-or-analyze with the shared claim protocol)", () => {
  it("runs exactly one analysis for concurrent callers of the same repository", async () => {
    const { state, deps } = fakeAgent();
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveReport(deps({ analyzeMs: 20 }), { timeoutMs: 2000, pollMs: 2 })));
    expect(state.analyses).toBe(1);
    expect(results.every((r) => r.report === "report-v1")).toBe(true);
    expect(results.filter((r) => !r.cached)).toHaveLength(1);
    expect(results.filter((r) => r.cached)).toHaveLength(7);
  });

  it("serves the cache without analyzing", async () => {
    const { state, deps } = fakeAgent();
    state.report = "warm";
    const r = await resolveReport(deps());
    expect(r).toEqual({ report: "warm", cached: true });
    expect(state.analyses).toBe(0);
  });

  it("releases the claim when the analysis fails so the next caller can retry", async () => {
    const { state, deps } = fakeAgent();
    await expect(resolveReport(deps({ fail: true }))).rejects.toThrow(/github exploded/);
    expect(state.inflight).toBeNull();
    expect(state.released).toHaveLength(1);
    const retry = await resolveReport(deps());
    expect(retry.cached).toBe(false);
    expect(state.analyses).toBe(2);
  });

  it("gives up with a retryable 503 if somebody else's analysis never finishes", async () => {
    const { state, deps } = fakeAgent();
    state.inflight = "someone-else";
    let err: unknown;
    try {
      await resolveReport(deps(), { timeoutMs: 20, pollMs: 5 });
    } catch (e) {
      err = e;
    }
    expect(err instanceof ApiError).toBe(true);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).retryAfterSeconds).toBe(5);
    expect(state.analyses).toBe(0);
  });

  it("takes over when the other analysis disappears (claim released) while waiting", async () => {
    const { state, deps } = fakeAgent();
    state.inflight = "someone-else";
    setTimeout(() => {
      state.inflight = null;
    }, 10);
    const r = await resolveReport(deps(), { timeoutMs: 1000, pollMs: 3 });
    expect(r.cached).toBe(false);
    expect(state.analyses).toBe(1);
  });
});
