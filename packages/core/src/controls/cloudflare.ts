import type { Control, Evidence, Snapshot } from "../types.ts";
import { prefetch } from "../snapshot.ts";
import { basename, capList, daysBetween, isRecord, isVendored, lineOf, NON_PROD, parseJsonc } from "../util.ts";
import { fail, pass, unknown } from "./helpers.ts";

const WRANGLER = /(^|\/)wrangler\.(toml|jsonc?)$/;
const MAX_CONFIGS = 10;
/** Workers should track the runtime; a year is the longest we treat as "current". */
export const MAX_COMPAT_AGE_DAYS = 365;

type Json = Record<string, unknown>;

function stripTomlComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === "\\" && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function unquote(key: string): string {
  const k = key.trim();
  return (k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")) ? k.slice(1, -1) : k;
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "\\" && inStr === '"') cur += text[++i] ?? "";
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseTomlValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("{") && v.endsWith("}")) {
    const obj: Json = {};
    for (const part of splitTopLevel(v.slice(1, -1), ",")) {
      const eq = part.indexOf("=");
      if (eq > 0) obj[unquote(part.slice(0, eq))] = parseTomlValue(part.slice(eq + 1));
    }
    return obj;
  }
  if (v.startsWith("[")) return [];
  return v;
}

function ensureTable(root: Json, path: string[]): Json {
  let cur = root;
  for (const seg of path) {
    const next = cur[seg];
    if (isRecord(next)) cur = next;
    else {
      const created: Json = {};
      cur[seg] = created;
      cur = created;
    }
  }
  return cur;
}

/** A forgiving TOML subset reader: tables, dotted keys, scalars and inline tables. Enough for wrangler.toml. */
export function parseTomlLoose(text: string): Json {
  const root: Json = {};
  let cur = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const table = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (table) {
      cur = ensureTable(root, splitTopLevel(table[1]!, ".").map(unquote));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const keyPath = splitTopLevel(line.slice(0, eq), ".").map(unquote);
    const leaf = keyPath.pop();
    if (!leaf) continue;
    ensureTable(cur, keyPath)[leaf] = parseTomlValue(line.slice(eq + 1));
  }
  return root;
}

export interface WranglerConfig {
  path: string;
  text: string;
  data: Json;
}

async function loadWranglerConfigs(snapshot: Snapshot): Promise<{ configs: WranglerConfig[]; unreadable: string[] }> {
  const paths = snapshot.paths.filter((p) => WRANGLER.test(p) && !isVendored(p) && !NON_PROD.test(p)).slice(0, MAX_CONFIGS);
  await prefetch(snapshot, paths);
  const configs: WranglerConfig[] = [];
  const unreadable: string[] = [];
  for (const path of paths) {
    const text = await snapshot.read(path);
    if (text === null) {
      unreadable.push(path);
      continue;
    }
    const data = basename(path).endsWith(".toml") ? parseTomlLoose(text) : parseJsonc<Json>(text);
    if (!isRecord(data)) unreadable.push(path);
    else configs.push({ path, text, data });
  }
  return { configs, unreadable };
}

export const WRANGLER_COMPAT_DATE: Control = {
  id: "CDX-050",
  title: "Worker compatibility_date is current",
  category: "cloudflare",
  severity: "low",
  rationale: "compatibility_date pins the Workers runtime behavior your code sees. A stale date means missing fixes and features, and a jump later is a larger, riskier change.",
  remediation: `Set compatibility_date to a recent date (within ${MAX_COMPAT_AGE_DAYS} days) and test; update it as part of regular dependency upgrades.`,
  agentRule: "Keep wrangler `compatibility_date` recent; do not lower it or remove compatibility flags without a reason recorded in the change.",
  appliesTo: (p) => p.hasWrangler,
  async check({ snapshot, now }) {
    const { configs, unreadable } = await loadWranglerConfigs(snapshot);
    const bad: Evidence[] = [];
    let unsure = unreadable.length;
    for (const c of configs) {
      const date = c.data.compatibility_date;
      if (typeof date !== "string") {
        // Pages projects and some generated configs legitimately omit it.
        bad.push({ path: c.path, message: "No compatibility_date set; the runtime defaults to the oldest behavior." });
        continue;
      }
      const d = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) {
        unsure++;
        continue;
      }
      const age = daysBetween(d, now);
      if (age < -7) unsure++;
      else if (age > MAX_COMPAT_AGE_DAYS) bad.push({ path: c.path, message: `compatibility_date ${date} is ${age} days old (limit ${MAX_COMPAT_AGE_DAYS}).` });
    }
    if (bad.length) return fail(...bad);
    if (configs.length === 0) return unknown("Wrangler configuration could not be read.");
    return unsure ? unknown("Some compatibility_date values could not be evaluated.") : pass({ message: `compatibility_date is current in ${configs.length} config(s).` });
  }
};

export const WRANGLER_OBSERVABILITY: Control = {
  id: "CDX-051",
  title: "Worker observability is enabled",
  category: "cloudflare",
  severity: "low",
  defaultMode: "audit",
  rationale: "A Worker without observability enabled is a black box in production: when it misbehaves there are no logs or traces to debug from.",
  remediation: 'Add `"observability": { "enabled": true }` to the Wrangler configuration.',
  agentRule: "Keep `observability.enabled` on in wrangler config, and log structured, secret-free events for errors.",
  appliesTo: (p) => p.hasWrangler,
  async check({ snapshot }) {
    const { configs, unreadable } = await loadWranglerConfigs(snapshot);
    if (configs.length === 0) return unknown("Wrangler configuration could not be read.");
    const bad: Evidence[] = [];
    for (const c of configs) {
      const obs = c.data.observability;
      if (!(isRecord(obs) && obs.enabled === true)) bad.push({ path: c.path, message: "observability.enabled is not true." });
    }
    if (bad.length) return fail(...bad);
    return unreadable.length ? unknown("Some Wrangler configs could not be read.") : pass({ message: `Observability enabled in ${configs.length} config(s).` });
  }
};

const SECRET_KEY = /(SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|AUTH_?TOKEN|(^|_)TOKEN($|_)|CREDENTIAL)/i;
const BENIGN_KEY_SUFFIX = /_(URL|URI|ENDPOINT|HOST|NAME|HEADER|PATH|FILE|ENABLED|ID|TTL|TIMEOUT)$/i;

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return (
    v === "" ||
    /^(true|false|null|undefined)$/i.test(v) ||
    /^(xxx+|\*+|changeme|change-me|todo|replace[-_ ]?me|placeholder|<[^>]*>|\$\{?[A-Za-z_]+\}?)$/i.test(v) ||
    (/^https?:\/\//i.test(v) && !/^https?:\/\/[^/@\s]+@/i.test(v))
  );
}

function literalSecrets(vars: unknown): string[] {
  if (!isRecord(vars)) return [];
  return Object.entries(vars)
    .filter(([key, value]) => typeof value === "string" && SECRET_KEY.test(key) && !BENIGN_KEY_SUFFIX.test(key) && !isPlaceholder(value))
    .map(([key]) => key);
}

export const WRANGLER_NO_SECRET_VARS: Control = {
  id: "CDX-052",
  title: "Wrangler [vars] contain no literal secrets",
  category: "cloudflare",
  severity: "high",
  defaultMode: "enforce",
  rationale: "`vars` in wrangler config are plain text and are committed with the repo. Secrets belong in `wrangler secret put` or Secrets Store, never in config.",
  remediation: "Remove the value, rotate it, and set it with `wrangler secret put NAME` (or bind a Secrets Store secret). Keep only non-sensitive settings in `vars`.",
  agentRule: "Never put tokens, keys or passwords in wrangler `vars`; use `wrangler secret put` and reference the binding by name.",
  appliesTo: (p) => p.hasWrangler,
  async check({ snapshot }) {
    const { configs, unreadable } = await loadWranglerConfigs(snapshot);
    if (configs.length === 0) return unknown("Wrangler configuration could not be read.");
    const bad: Evidence[] = [];
    for (const c of configs) {
      const scopes: Array<[string, unknown]> = [["vars", c.data.vars]];
      if (isRecord(c.data.env)) for (const [name, env] of Object.entries(c.data.env)) if (isRecord(env)) scopes.push([`env.${name}.vars`, env.vars]);
      for (const [scope, vars] of scopes) {
        for (const key of literalSecrets(vars)) {
          const idx = c.text.search(new RegExp(`["']?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]`));
          bad.push({ path: c.path, line: idx >= 0 ? lineOf(c.text, idx) : undefined, message: `${scope}.${key} holds a literal value (hidden); use a secret binding instead.` });
        }
      }
    }
    if (bad.length) return fail(...capList(bad, 10, (n) => ({ message: `...and ${n} more.` })));
    return unreadable.length ? unknown("Some Wrangler configs could not be read.") : pass({ message: `No literal secrets in vars across ${configs.length} config(s).` });
  }
};
