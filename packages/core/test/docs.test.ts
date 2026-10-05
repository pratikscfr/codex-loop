import { readFile } from "node:fs/promises";
import { describe, expect, it } from "./testing.ts";
import { CONTROLS } from "../src/index.ts";
import { renderControlsDoc } from "../../../scripts/controls-doc.mts";

describe("catalog integrity", () => {
  it("control ids are unique, well-formed and fully documented", () => {
    const ids = CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CONTROLS) {
      expect(c.id, c.id).toMatch(/^CDX-\d{3}$/);
      for (const field of ["title", "rationale", "remediation", "agentRule"] as const) {
        expect(c[field].trim().length > 10, `${c.id}.${field}`).toBe(true);
      }
      expect(c.agentRule.length <= 200, `${c.id} agentRule should be one short line`).toBe(true);
      expect(c.agentRule.includes("\n"), `${c.id} agentRule is single-line`).toBe(false);
    }
  });

  it("docs/CONTROLS.md matches the code (run `npm run docs` to regenerate)", async () => {
    const onDisk = await readFile(new URL("../../../docs/CONTROLS.md", import.meta.url), "utf8");
    expect(onDisk).toBe(renderControlsDoc());
  });
});
