import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import { buildAdvisory, citableControlIds, extractJsonObject, normalizeForMatch } from "../src/lib/citations.ts";
import { sampleReport } from "./fixtures.ts";

const META = { generatedBy: "@cf/test/model", generatedAt: "2026-10-05T12:05:00.000Z" };
const p = (controlId: string, why = "because", firstStep = "do it") => ({ controlId, why, firstStep });

describe("citableControlIds", () => {
  it("contains only live failures: not pass, unknown or suppressed", () => {
    expect([...citableControlIds(sampleReport())].sort()).toEqual(["CDX-001", "CDX-005"]);
  });
});

describe("buildAdvisory (citation validator)", () => {
  const report = sampleReport();

  it("keeps priorities that cite live failing controls", () => {
    const a = buildAdvisory({ summary: "Two things to fix.", priorities: [p("CDX-001"), p("cdx-005")] }, report, META);
    expect(a).toEqual({
      generatedBy: META.generatedBy,
      generatedAt: META.generatedAt,
      summary: "Two things to fix.",
      priorities: [p("CDX-001"), p("CDX-005")]
    });
  });

  it("drops priorities for passing, unknown, suppressed and nonexistent controls", () => {
    const a = buildAdvisory(
      {
        summary: "x",
        priorities: [p("CDX-002"), p("CDX-003"), p("CDX-004"), p("CDX-999"), p("NOPE"), p("CDX-005")]
      },
      report,
      META
    );
    expect(a?.priorities.map((x) => x.controlId)).toEqual(["CDX-005"]);
  });

  it("drops the whole advisory when nothing valid remains", () => {
    expect(buildAdvisory({ summary: "x", priorities: [p("CDX-002"), p("CDX-003")] }, report, META)).toBeNull();
    expect(buildAdvisory({ summary: "x", priorities: [] }, report, META)).toBeNull();
  });

  it("drops priorities whose text mentions a control that is not a live failure", () => {
    const a = buildAdvisory(
      { summary: "ok", priorities: [p("CDX-001", "also see CDX-002", "x"), p("CDX-005", "fine", "then CDX-777")] },
      report,
      META
    );
    expect(a).toBeNull();
    const b = buildAdvisory({ summary: "ok", priorities: [p("CDX-001", "and CDX-005 together", "x")] }, report, META);
    expect(b?.priorities).toHaveLength(1);
  });

  it("rejects a summary that talks about a non-failing control, but ignores unrelated tokens", () => {
    expect(buildAdvisory({ summary: "CDX-002 is broken", priorities: [p("CDX-001")] }, report, META)).toBeNull();
    const ok = buildAdvisory({ summary: "Uses SHA-256 and CVE-2024-1 wording", priorities: [p("CDX-001")] }, report, META);
    expect(ok?.summary).toBe("Uses SHA-256 and CVE-2024-1 wording");
  });

  it("de-duplicates and caps at five priorities", () => {
    const many = {
      summary: "x",
      priorities: [p("CDX-001"), p("CDX-001"), p("CDX-005")]
    };
    expect(buildAdvisory(many, report, META)?.priorities).toHaveLength(2);

    const big = sampleReportWith(8);
    const a = buildAdvisory(
      { summary: "x", priorities: Array.from({ length: 8 }, (_, i) => p(`CDX-${100 + i}`)) },
      big,
      META
    );
    expect(a?.priorities).toHaveLength(5);
  });

  it("clamps lengths and collapses whitespace instead of failing", () => {
    const a = buildAdvisory(
      { summary: "s".repeat(900), priorities: [p("CDX-001", "w\n\nhy   " + "y".repeat(600), "f".repeat(600))] },
      report,
      META
    );
    expect(a?.summary.length).toBeLessThanOrEqual(600);
    expect(a?.priorities[0]?.why.length).toBeLessThanOrEqual(400);
    expect(a?.priorities[0]?.firstStep.length).toBeLessThanOrEqual(400);
    expect(a?.priorities[0]?.why.includes("\n")).toBe(false);
  });

  it("rejects malformed shapes", () => {
    for (const raw of [null, "text", 5, [], {}, { summary: 1, priorities: [] }, { summary: "x" }, { summary: "x", priorities: "no" }, { summary: "", priorities: [p("CDX-001")] }, { summary: "x", priorities: [{ controlId: "CDX-001" }] }]) {
      expect(buildAdvisory(raw, report, META)).toBeNull();
    }
  });
});

describe("extractJsonObject", () => {
  it("handles bare JSON, fenced JSON and JSON wrapped in prose", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! Here you go:\n{"a":{"b":2}}\nHope that helps.')).toEqual({ a: { b: 2 } });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJsonObject("no json here")).toThrow();
    expect(() => extractJsonObject("{ broken")).toThrow();
  });
});

function sampleReportWith(n: number) {
  const base = sampleReport();
  const extra = Array.from({ length: n }, (_, i) => ({ ...base.results[0]!, id: `CDX-${100 + i}` }));
  return { ...base, results: [...base.results, ...extra] };
}

describe("obfuscated control ids and links (NFKC + separator-tolerant matching)", () => {
  const report = sampleReport(); // live failures: CDX-001, CDX-005; CDX-002 passes; CDX-003 suppressed; CDX-004 unknown
  const good = (text: string) => buildAdvisory({ summary: "ok", priorities: [p("CDX-001", text, "fix it")] }, report, META);

  it("normalizeForMatch folds full-width forms and strips invisible format characters", () => {
    expect(normalizeForMatch("ＣＤＸ－０２１")).toBe("CDX-021");
    expect(normalizeForMatch("CD\u200bX-0\u200d21\u00ad")).toBe("CDX-021");
  });

  it("flags a mention of a non-failing control however the id is spelled", () => {
    const spellings = ["CDX 002", "CDX002", "cdx_002", "CDX-002", "CDX\u2011002", "CDX\u2013002", "CDX\u2212002", "CDX\uFF0D002", "ＣＤＸ－００２", "CDX\u200b-002", "CDX  -  002", "CDX-2"];
    for (const spelling of spellings) {
      expect(good(`also look at ${spelling} please`)).toBeNull();
    }
  });

  it("flags unknown ids and suppressed / unknown controls too", () => {
    for (const s of ["CDX 003", "CDX004", "CDX‑999", "cdx 7"]) expect(good(`see ${s}`)).toBeNull();
    expect(buildAdvisory({ summary: "CDX 003 is bad", priorities: [p("CDX-001")] }, report, META)).toBeNull();
    expect(buildAdvisory({ summary: "ＣＤＸ００２", priorities: [p("CDX-001")] }, report, META)).toBeNull();
  });

  it("still allows mentions of live failing controls in any spelling", () => {
    expect(good("together with CDX 005")?.priorities).toHaveLength(1);
    expect(good("together with cdx005")?.priorities).toHaveLength(1);
    expect(good("together with CDX‑5")?.priorities).toHaveLength(1);
  });

  it("resolves a controlId field written with odd separators to the real failing id", () => {
    const a = buildAdvisory({ summary: "x", priorities: [p("CDX 001"), p("cdx005"), p("CDX‑002"), p("ＣＤＸ－００５")] }, report, META);
    expect(a?.priorities.map((x) => x.controlId)).toEqual(["CDX-001", "CDX-005"]);
  });

  it("rejects the whole advisory when any field contains an http(s) URL or a backtick", () => {
    for (const bad of ["see https://evil.example/x", "visit HTTP://evil.example", "run `rm -rf /`", "ｈｔｔｐｓ：／／evil.example"]) {
      expect(buildAdvisory({ summary: bad, priorities: [p("CDX-001")] }, report, META)).toBeNull();
      expect(buildAdvisory({ summary: "fine", priorities: [p("CDX-001", bad, "fix")] }, report, META)).toBeNull();
      expect(buildAdvisory({ summary: "fine", priorities: [p("CDX-001", "why", bad)] }, report, META)).toBeNull();
      // even in a priority that would otherwise be dropped
      expect(buildAdvisory({ summary: "fine", priorities: [p("CDX-001"), p("CDX-002", bad, "x")] }, report, META)).toBeNull();
    }
    expect(buildAdvisory({ summary: "no links here", priorities: [p("CDX-001")] }, report, META)).toBeTruthy();
  });
});
