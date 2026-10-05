import { analyze, createMemorySnapshot, type ControlResult, type Report } from "../src/index.ts";

/** Fixed clock so date-based controls are deterministic. */
export const NOW = new Date("2026-10-05T12:00:00Z");

export async function run(files: Record<string, string>, opts: { maxFileReads?: number } = {}): Promise<Report> {
  return analyze(createMemorySnapshot(files, { maxFileReads: opts.maxFileReads }), { now: NOW });
}

export function get(report: Report, id: string): ControlResult {
  const r = report.results.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r;
}

export const LONG_README = "# Project\n" + "This project does useful things and here is how to run and test it. ".repeat(5);
