import { describe, expect, it } from "./testing.ts";
import { analyze, createMemorySnapshot, type Control } from "../src/index.ts";
import { get, LONG_README, NOW, run } from "./helpers.ts";

const PKG = JSON.stringify({ name: "x", scripts: { test: "vitest", build: "tsc" } });

describe("engine", () => {
  it("never throws on an empty repository and is deterministic", async () => {
    const a = await run({});
    const b = await run({});
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.summary.blocking).toBe(0);
    expect(a.coverage.filesTotal).toBe(0);
  });

  it("turns a crashing check into unknown with a note instead of failing the run", async () => {
    const boom: Control = {
      id: "CDX-900",
      title: "boom",
      category: "hygiene",
      severity: "low",
      rationale: "r",
      remediation: "m",
      agentRule: "a",
      async check() {
        throw new Error("kaboom");
      }
    };
    const report = await analyze(createMemorySnapshot({ "a.txt": "x" }), { now: NOW, controls: [boom] });
    expect(report.results[0]?.status).toBe("unknown");
    expect(report.results[0]?.note).toContain("kaboom");
  });

  it("re-throws transient infrastructure errors so they can be retried", async () => {
    const flaky: Control = {
      id: "CDX-901",
      title: "flaky",
      category: "hygiene",
      severity: "low",
      rationale: "r",
      remediation: "m",
      agentRule: "a",
      async check() {
        throw Object.assign(new Error("rate limited"), { transient: true });
      }
    };
    await expect(analyze(createMemorySnapshot({ "a.txt": "x" }), { now: NOW, controls: [flaky] })).rejects.toThrow("rate limited");
  });

  it("reports unknown when a control exhausts the file read budget", async () => {
    const wf = "permissions: {}\njobs: {}\n";
    const files = { ".github/workflows/a.yml": wf, ".github/workflows/b.yml": wf, ".github/workflows/c.yml": wf };
    const r = await run(files, { maxFileReads: 1 });
    expect(["unknown", "pass", "fail"]).toContain(get(r, "CDX-012").status);
    // At least one control downstream of the exhausted budget must say so rather than guessing.
    expect(r.results.some((x) => x.status === "unknown")).toBe(true);
  });

  it("applies rollout modes: control default, global default, per-control override", async () => {
    const files = { "package.json": PKG, ".env": "A=1", "README.md": LONG_README };
    let r = await run(files);
    expect(get(r, "CDX-031").mode).toBe("enforce");
    expect(get(r, "CDX-002").mode).toBe("warn");
    expect(r.summary.blocking).toBeGreaterThan(0);

    r = await run({ ...files, ".codex-loop.yml": "mode: audit\ncontrols:\n  CDX-031: warn\n" });
    expect(get(r, "CDX-031").mode).toBe("warn");
    expect(get(r, "CDX-002").mode).toBe("audit");
    expect(get(r, "CDX-032").mode).toBe("enforce"); // control default wins over the global default
    expect(r.summary.blocking).toBe(0);

    r = await run({ ...files, ".codex-loop.yml": "controls:\n  CDX-031: { disabled: true }\n" });
    expect(get(r, "CDX-031").status).toBe("na");
  });

  it("time-boxed exceptions: active suppresses, expired re-enforces, invalid is reported and ignored", async () => {
    const base = { "package.json": PKG, "README.md": LONG_README };
    const cfg = (expires: string, extra = "") =>
      `exceptions:\n  - control: CDX-002\n    reason: handled at org level\n    owner: platform\n    expires: ${expires}\n${extra}`;

    let r = await run({ ...base, ".codex-loop.yml": cfg("2026-12-31") });
    expect(get(r, "CDX-002").exception?.reason).toBe("handled at org level");
    expect(r.summary.suppressed).toBe(1);
    expect(r.configIssues).toHaveLength(0);

    r = await run({ ...base, ".codex-loop.yml": cfg("2026-10-01") });
    const expired = get(r, "CDX-002");
    expect(expired.exception).toBeUndefined();
    expect(expired.expiredException?.expires).toBe("2026-10-01");
    expect(expired.evidence.map((e) => e.message).join(" ")).toContain("expired on 2026-10-01");
    expect(r.summary.suppressed).toBe(0);

    // Expiring today is still active (inclusive).
    r = await run({ ...base, ".codex-loop.yml": cfg("2026-10-05") });
    expect(get(r, "CDX-002").exception).toBeTruthy();

    // No expiry, too far out, missing reason, unknown control: all rejected with a message.
    const bad = [
      "exceptions:\n  - control: CDX-002\n    reason: because\n",
      cfg("2031-01-01"),
      "exceptions:\n  - control: CDX-002\n    expires: 2026-12-31\n",
      "exceptions:\n  - control: CDX-999\n    reason: x\n    expires: 2026-12-31\n",
      "exceptions:\n  - control: CDX-002\n    reason: x\n    expires: soon\n"
    ];
    for (const yml of bad) {
      r = await run({ ...base, ".codex-loop.yml": yml });
      expect(get(r, "CDX-002").exception).toBeUndefined();
      expect(r.configIssues.length).toBeGreaterThan(0);
    }
  });

  it("broken config files fall back to defaults with an issue, never a crash", async () => {
    for (const yml of ["::: not yaml :::\n\t- [", "- just\n- a list\n", "mode: loud\ncontrols: 5\nexceptions: nope\n", "42"]) {
      const r = await run({ "README.md": LONG_README, ".codex-loop.yml": yml });
      expect(r.results.length).toBeGreaterThan(10);
      expect(r.configIssues.length).toBeGreaterThan(0);
    }
    const json = await run({ "README.md": LONG_README, ".codex-loop.json": '{ // comment\n "mode": "enforce", }' });
    expect(get(json, "CDX-002").mode).toBe("enforce");
  });

  it("summary counts stay consistent with results", async () => {
    const r = await run({ "package.json": PKG, "README.md": LONG_README, ".env": "A=1" });
    const s = r.summary;
    expect(s.pass + s.fail + s.unknown + s.na + s.suppressed).toBe(r.results.length);
    const sev = Object.values(s.bySeverity).reduce((a, b) => a + b, 0);
    expect(sev).toBe(s.fail);
  });
});
