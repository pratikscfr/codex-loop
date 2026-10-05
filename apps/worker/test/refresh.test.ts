import { readFileSync } from "node:fs";
import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import { VIEW_TOUCH_INTERVAL_MS, VIEW_WINDOW_MS, refreshAllowed, shouldRecordView } from "../src/lib/refresh.ts";

const DAY = 24 * 60 * 60_000;
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("refreshAllowed (7-day window since the last USER view)", () => {
  it("is false for a repo nobody has viewed", () => {
    expect(refreshAllowed(1_000_000_000_000, 0)).toBe(false);
    expect(refreshAllowed(1_000_000_000_000, Number.NaN)).toBe(false);
    expect(refreshAllowed(1_000_000_000_000, -5)).toBe(false);
  });

  it("is true inside the window and false right after it", () => {
    const t0 = 1_700_000_000_000;
    expect(refreshAllowed(t0 + 1 * DAY, t0)).toBe(true);
    expect(refreshAllowed(t0 + 7 * DAY, t0)).toBe(true);
    expect(refreshAllowed(t0 + 7 * DAY + 1, t0)).toBe(false);
    expect(VIEW_WINDOW_MS).toBe(7 * DAY);
  });

  it("a repo viewed once and then ignored stops refreshing after a week (the refresh never renews the window)", () => {
    const t0 = 1_700_000_000_000;
    let lastUserView = t0; // the one and only human view
    const ran: number[] = [];
    for (let day = 1; day <= 14; day++) {
      const now = t0 + day * DAY;
      if (!refreshAllowed(now, lastUserView)) break; // schedule cancels itself
      ran.push(day);
      // A refresh runs here. It must NOT touch lastUserView (saveReport / peekReport / claim without touch).
    }
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a user view extends the window", () => {
    const t0 = 1_700_000_000_000;
    let lastUserView = t0;
    lastUserView = t0 + 6 * DAY; // somebody opens the report on day 6
    expect(refreshAllowed(t0 + 12 * DAY, lastUserView)).toBe(true);
    expect(refreshAllowed(t0 + 14 * DAY, lastUserView)).toBe(false);
  });

  it("views are recorded at most once per interval", () => {
    const t = 1_700_000_000_000;
    expect(shouldRecordView(t, 0)).toBe(true);
    expect(shouldRecordView(t + 60_000, t)).toBe(false);
    expect(shouldRecordView(t + VIEW_TOUCH_INTERVAL_MS, t)).toBe(true);
  });
});

describe("only user-initiated reads renew last_viewed_at (source guards for the Durable Object wiring)", () => {
  const agent = read("../src/repo-agent.ts");
  const body = (name: string): string => {
    const start = agent.indexOf(`async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = agent.indexOf("\n  async ", start + 10);
    return agent.slice(start, next === -1 ? undefined : next);
  };

  it("saveReport, peekReport and the refresh path never record a view", () => {
    for (const m of ["saveReport", "saveAdvisory", "peekReport", "releaseAnalysis"]) {
      expect(body(m).includes("recordUserView")).toBe(false);
      expect(body(m).includes("last_viewed_at")).toBe(false);
    }
    const refresh = body("scheduledRefresh");
    expect(refresh.includes("recordUserView")).toBe(false);
    expect(refresh).toMatch(/claimAnalysis\(id, requestedRef, [^)]*, false\)/);
    expect(refresh).toMatch(/refreshAllowed\(/);
  });

  it("user reads do record a view", () => {
    for (const m of ["getBundle", "getReport", "getChat"]) expect(body(m)).toMatch(/recordUserView\(/);
    expect(body("getFreshReport")).toMatch(/if \(touch\) this\.recordUserView/);
    expect(body("claimAnalysis")).toMatch(/if \(touch\) this\.recordUserView/);
  });

  it("the workflow reads through peekReport, never the touching getReport", () => {
    const wf = read("../src/workflow.ts");
    expect(wf).toMatch(/peekReport\(\)/);
    expect(wf.includes(".getReport()")).toBe(false);
  });

  it("the MCP and HTTP analyze paths opt in to touching", () => {
    expect(read("../src/service.ts")).toMatch(/claimAnalysis\(id, "", CACHE_TTL_MS, true\)/);
    expect(read("../src/routes.ts")).toMatch(/getFreshReport\(CACHE_TTL_MS, "", true\)/);
    expect(read("../src/routes.ts")).toMatch(/claimAnalysis\(id, "", CACHE_TTL_MS, true\)/);
  });
});
