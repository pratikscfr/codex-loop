/**
 * Advisory validation. The LLM is never trusted: its JSON is parsed, shape-checked with zod, and
 * then every control it cites is checked against the deterministic report. Anything that does not
 * trace back to a currently failing, non-suppressed control is dropped.
 */
import { z } from "zod";
import type { Advisory, Report } from "@codex-loop/core";

export const SUMMARY_MAX = 600;
export const FIELD_MAX = 400;
export const PRIORITIES_MAX = 5;

const RawPriority = z.object({
  controlId: z.string().trim().min(1).max(40),
  why: z.string().trim().min(1),
  firstStep: z.string().trim().min(1)
});

export const RawAdvisory = z.object({
  summary: z.string().trim().min(1),
  priorities: z.array(RawPriority).max(25)
});

export type RawAdvisoryInput = z.infer<typeof RawAdvisory>;

/** Control ids the advisory may cite: live failures, i.e. status "fail" with no active exception. */
export function citableControlIds(report: Report): Set<string> {
  const out = new Set<string>();
  for (const r of report.results) {
    if (r.status === "fail" && !r.exception) out.add(r.id.toUpperCase());
  }
  return out;
}

/** Pull the first balanced-looking JSON object out of model text (handles ``` fences and prose). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

function clamp(s: string, max: number): string {
  // Collapse whitespace/control characters: these strings are rendered as plain text.
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Canonical form for matching: NFKC folds full-width/compatibility characters (so "ＣＤＸ－０２１"
 * becomes "CDX-021") and invisible format characters (zero-width spaces/joiners, soft hyphens) are
 * removed, so they cannot be used to hide a control id from the checks below.
 */
export function normalizeForMatch(s: string): string {
  return s.slice(0, 4000).normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/** Any Unicode dash/minus, underscore or whitespace, or nothing at all, between prefix and number. */
const SEP = "[\\s_\\-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]*";

const ID_SHAPE = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/;

/** "CDX-021" -> "CDX-21" (number compared numerically so "CDX 21" and "CDX021" collide with it). */
function canonicalKey(prefix: string, digits: string): string {
  return `${prefix.toUpperCase()}-${Number(digits)}`;
}

/** Prefixes of the report's own control ids ("CDX" for "CDX-021"). */
function idPrefixes(report: Report): string[] {
  const out = new Set<string>();
  for (const r of report.results) {
    const m = ID_SHAPE.exec(r.id);
    if (m?.[1]) out.add(m[1].toUpperCase());
  }
  return [...out];
}

/** Canonical key -> real control id, for live-failing controls only. */
function citableKeys(report: Report): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of report.results) {
    if (r.status !== "fail" || r.exception) continue;
    const m = ID_SHAPE.exec(r.id);
    out.set(m ? canonicalKey(m[1] as string, m[2] as string) : r.id.toUpperCase(), r.id);
  }
  return out;
}

/** Canonical keys of every control-id-like mention in free text. */
function mentionedKeys(text: string, prefixes: readonly string[]): string[] {
  if (prefixes.length === 0) return [];
  const re = new RegExp(`(${prefixes.join("|")})${SEP}(\\d{1,4})(?!\\d)`, "giu");
  const keys: string[] = [];
  for (const m of normalizeForMatch(text).matchAll(re)) keys.push(canonicalKey(m[1] as string, m[2] as string));
  return keys;
}

/** Resolve the `controlId` field (tolerating "CDX 021", "cdx021", fancy dashes) to a live failure. */
function resolveControlId(raw: string, prefixes: readonly string[], keys: Map<string, string>): string | null {
  const text = normalizeForMatch(raw).trim();
  const direct = keys.get(text.toUpperCase());
  if (direct) return direct;
  if (prefixes.length === 0) return null;
  const m = new RegExp(`^(${prefixes.join("|")})${SEP}(\\d{1,4})$`, "iu").exec(text);
  return m ? (keys.get(canonicalKey(m[1] as string, m[2] as string)) ?? null) : null;
}

/** Links and code spans are never part of a legitimate advisory. */
function hasLinkOrCode(text: string): boolean {
  const t = normalizeForMatch(text);
  return /https?:\/\//i.test(t) || t.includes("`");
}

export interface BuildAdvisoryMeta {
  generatedBy: string;
  generatedAt: string;
}

/**
 * Returns a safe Advisory, or null when nothing survives validation.
 *  - the advisory is rejected outright if any field contains an http(s):// URL or a backtick;
 *  - priorities citing a control that is not a live failure are dropped (ids are matched after NFKC
 *    normalisation, so "CDX 021" / "CDX021" / "CDX‑021" all resolve to CDX-021);
 *  - priorities / summary that *mention* a control-id-shaped token for a control that is not a live
 *    failure are dropped (priority) or invalidate the advisory (summary);
 *  - duplicates are removed, at most 5 priorities are kept, lengths are clamped.
 */
export function buildAdvisory(raw: unknown, report: Report, meta: BuildAdvisoryMeta): Advisory | null {
  const parsed = RawAdvisory.safeParse(raw);
  if (!parsed.success) return null;

  const allText = [parsed.data.summary, ...parsed.data.priorities.flatMap((p) => [p.why, p.firstStep])];
  if (allText.some(hasLinkOrCode)) return null;

  const keys = citableKeys(report);
  const prefixes = idPrefixes(report);
  const foreign = (text: string) => mentionedKeys(text, prefixes).some((k) => !keys.has(k));

  const summary = clamp(normalizeForMatch(parsed.data.summary), SUMMARY_MAX);
  if (!summary || foreign(summary)) return null;

  const seen = new Set<string>();
  const priorities: Advisory["priorities"] = [];
  for (const p of parsed.data.priorities) {
    const id = resolveControlId(p.controlId, prefixes, keys);
    if (!id || seen.has(id)) continue;
    const why = clamp(normalizeForMatch(p.why), FIELD_MAX);
    const firstStep = clamp(normalizeForMatch(p.firstStep), FIELD_MAX);
    if (!why || !firstStep) continue;
    if (foreign(`${why} ${firstStep}`)) continue;
    seen.add(id);
    priorities.push({ controlId: id, why, firstStep });
    if (priorities.length === PRIORITIES_MAX) break;
  }
  if (priorities.length === 0) return null;

  return { generatedBy: meta.generatedBy, generatedAt: meta.generatedAt, summary, priorities };
}
