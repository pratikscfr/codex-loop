import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import {
  MAX_STRING_CHARS,
  MAX_TOOL_RESULT_BYTES,
  ReportTooLargeError,
  capToolResult,
  clampText,
  controlView,
  fitReportForStorage,
  footprintView,
  historyEntry,
  isFresh,
  liveFailures,
  mapWorkflowStatus,
  sanitizeReport,
  summarizeReport,
  utf8Bytes
} from "../src/lib/shape.ts";
import { makeReport, result, sampleReport } from "./fixtures.ts";

describe("mapWorkflowStatus", () => {
  it("collapses workflow states into the API vocabulary", () => {
    expect(mapWorkflowStatus("queued")).toBe("queued");
    for (const s of ["running", "waiting", "waitingForPause", "rollingBack"]) expect(mapWorkflowStatus(s)).toBe("running");
    expect(mapWorkflowStatus("complete")).toBe("complete");
    expect(mapWorkflowStatus("errored")).toBe("errored");
    expect(mapWorkflowStatus("terminated")).toBe("terminated");
    expect(mapWorkflowStatus("paused")).toBe("paused");
    expect(mapWorkflowStatus("something-new")).toBe("unknown");
  });
});

describe("history + failures", () => {
  it("historyEntry copies the summary numbers", () => {
    expect(historyEntry(sampleReport())).toEqual({
      generatedAt: "2026-10-05T12:00:00.000Z",
      pass: 1,
      fail: 2,
      unknown: 1,
      blocking: 1
    });
  });

  it("liveFailures excludes suppressed, sorts by severity, and filters", () => {
    const r = sampleReport();
    expect(liveFailures(r).map((x) => x.id)).toEqual(["CDX-001", "CDX-005"]);
    expect(liveFailures(r, "high").map((x) => x.id)).toEqual(["CDX-005"]);
    expect(liveFailures(r, "low")).toEqual([]);
  });

  it("controlView marks suppressed failures and bounds evidence", () => {
    const r = sampleReport();
    const suppressed = controlView(r.results[2]!);
    expect(suppressed.status).toBe("suppressed");
    expect(suppressed.suppressedBy?.reason).toBe("legacy");
    const many = result("CDX-010", "fail", { evidence: Array.from({ length: 9 }, (_, i) => ({ message: `e${i}` })) });
    expect(controlView(many, 3).evidence).toHaveLength(3);
    expect(controlView(many).verified).toBe(true);
  });
});

describe("summarizeReport", () => {
  it("is compact, labelled, and only includes live failures", () => {
    const s = summarizeReport(sampleReport(), { maxFailing: 1, maxEvidence: 1 });
    expect(s.repo).toBe("acme/widgets");
    expect(s.counts.fail).toBe(2);
    expect(s.counts.suppressed).toBe(1);
    expect(s.failing).toHaveLength(1);
    expect(s.failing[0]?.id).toBe("CDX-001");
    expect(s.note).toMatch(/deterministic/);
  });

  it("footprintView never throws when footprint is missing", () => {
    expect(footprintView(undefined)).toEqual({ available: false, reason: "No agent-footprint data was collected for this report." });
  });
});

describe("fitReportForStorage", () => {
  it("returns the report untouched when it fits", () => {
    const r = sampleReport();
    expect(fitReportForStorage(r)).toBe(JSON.stringify(r));
  });

  it("shrinks evidence until the JSON fits", () => {
    const big = makeReport([
      result("CDX-001", "fail", {
        evidence: Array.from({ length: 200 }, (_, i) => ({ path: `p${i}`, message: "m".repeat(200) }))
      })
    ]);
    const out = fitReportForStorage(big, 10_000);
    expect(out.length).toBeLessThanOrEqual(10_000);
    const parsed = JSON.parse(out) as typeof big;
    expect(parsed.results[0]?.id).toBe("CDX-001");
    expect(parsed.summary.fail).toBe(1);
  });
});

describe("isFresh", () => {
  const now = Date.parse("2026-10-05T12:10:00.000Z");
  it("is true inside the ttl and false outside or for garbage", () => {
    expect(isFresh("2026-10-05T12:00:00.000Z", now, 15 * 60_000)).toBe(true);
    expect(isFresh("2026-10-05T11:50:00.000Z", now, 15 * 60_000)).toBe(false);
    expect(isFresh("not a date", now, 15 * 60_000)).toBe(false);
    expect(isFresh("2026-10-05T13:00:00.000Z", now, 15 * 60_000)).toBe(false);
  });
});

describe("clamping repo-derived strings (~300 chars)", () => {
  const long = "x".repeat(5000);

  it("clampText bounds length, strips control characters and marks the cut", () => {
    expect(clampText("a\nb\u0000c")).toBe("a b c");
    const out = clampText(long);
    expect(out).toHaveLength(MAX_STRING_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(clampText(undefined)).toBe("");
  });

  it("controlView clamps evidence path/message, exception reason and notes", () => {
    const r = result("CDX-001", "fail", {
      evidence: [{ path: long, line: 1, message: long }],
      note: long,
      exception: { control: "CDX-001", reason: long, expires: "2027-01-01", owner: long }
    });
    const v = controlView(r);
    expect(v.evidence[0]?.path?.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
    expect(v.evidence[0]?.message.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
    expect(v.suppressedBy?.reason.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
    expect((v.note ?? "").length).toBeLessThanOrEqual(MAX_STRING_CHARS);
  });

  it("summarizeReport clamps evidence that reaches the chat model and MCP clients", () => {
    const report = makeReport([result("CDX-001", "fail", { evidence: [{ path: long, message: long }] })]);
    const s = summarizeReport(report);
    expect(s.failing[0]?.evidence[0]?.message.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
    expect(s.failing[0]?.evidence[0]?.path?.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
  });

  it("sanitizeReport clamps every repo-derived field before storage", () => {
    const report = makeReport(
      [
        result("CDX-001", "fail", {
          evidence: Array.from({ length: 80 }, () => ({ path: long, message: long })),
          note: long,
          exception: { control: "CDX-001", reason: long, expires: "2027-01-01", owner: long },
          expiredException: { control: "CDX-001", reason: long, expires: "2020-01-01" }
        })
      ],
      { configIssues: Array.from({ length: 40 }, () => long) }
    );
    const clean = sanitizeReport(report);
    const r = clean.results[0]!;
    expect(r.evidence).toHaveLength(50);
    expect(r.evidence.every((e) => (e.path ?? "").length <= 300 && e.message.length <= 300)).toBe(true);
    expect(r.exception?.reason.length).toBeLessThanOrEqual(300);
    expect((r.exception?.owner ?? "").length).toBeLessThanOrEqual(300);
    expect(r.expiredException?.reason.length).toBeLessThanOrEqual(300);
    expect((r.note ?? "").length).toBeLessThanOrEqual(300);
    expect(clean.configIssues).toHaveLength(20);
    expect(clean.configIssues.every((c) => c.length <= 300)).toBe(true);
    // structure is preserved
    expect(clean.summary).toEqual(report.summary);
  });
});

describe("capToolResult (~8 KB per chat tool result)", () => {
  it("passes small results through untouched", () => {
    const small = { a: 1, list: ["x"] };
    expect(capToolResult(small)).toBe(small);
  });

  it("replaces an oversized result by a cut-off envelope that itself fits the budget", () => {
    const huge = { failures: Array.from({ length: 500 }, (_, i) => ({ id: `CDX-${i}`, message: "m".repeat(200), q: '"quoted"' })) };
    const out = capToolResult(huge) as { truncated?: boolean; note?: string; partialJson?: string };
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/narrower/);
    expect(utf8Bytes(JSON.stringify(out))).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect((out.partialJson ?? "").startsWith('{"failures":[{"id":"CDX-0"')).toBe(true);
  });

  it("measures bytes, not characters", () => {
    const multibyte = { text: "é".repeat(5000) }; // 5000 chars, 10 KB in UTF-8
    const out = capToolResult(multibyte, 8192) as { truncated?: boolean };
    expect(out.truncated).toBe(true);
  });
});

describe("fitReportForStorage measures UTF-8 bytes", () => {
  it("shrinks a report whose UTF-16 length fits but whose UTF-8 size does not", () => {
    const evidence = Array.from({ length: 30 }, () => ({ path: "p", message: "漢".repeat(1000) })); // 3 bytes per char
    const report = makeReport([result("CDX-001", "fail", { evidence })]);
    const json = JSON.stringify(report);
    expect(json.length < 40_000).toBe(true);
    expect(utf8Bytes(json)).toBeGreaterThan(40_000);
    const fitted = fitReportForStorage(report, 40_000);
    expect(utf8Bytes(fitted)).toBeLessThanOrEqual(40_000);
    expect(JSON.parse(fitted).results[0].evidence.length < 30).toBe(true);
  });

  it("defaults to about 1.8 MB and throws a dedicated error when nothing can fit", () => {
    const report = makeReport([result("CDX-001", "fail")]);
    expect(fitReportForStorage(report).length).toBeGreaterThan(0);
    let err: unknown;
    try {
      fitReportForStorage(report, 50);
    } catch (e) {
      err = e;
    }
    expect(err instanceof ReportTooLargeError).toBe(true);
    expect((err as Error).name).toBe("ReportTooLargeError");
  });
});
