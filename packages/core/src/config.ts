import { parse as parseYaml } from "yaml";
import type { Config, ControlException, Mode, Snapshot } from "./types.ts";
import { isRecord, stripJsonComments } from "./util.ts";

export const CONFIG_FILES = [".codex-loop.yml", ".codex-loop.yaml", ".codex-loop.json"] as const;
const MODES: readonly Mode[] = ["audit", "warn", "enforce"];
/** Exceptions may not be open-ended: one year at most. */
export const MAX_EXCEPTION_DAYS = 366;

export const DEFAULT_CONFIG: Config = {
  version: 1,
  mode: "warn",
  controls: {},
  exceptions: []
};

export interface LoadedConfig {
  config: Config;
  issues: string[];
  /** Which file the config came from, if any. */
  source?: string;
}

function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

function toIsoDate(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    const s = v.trim();
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s) return s;
  }
  return undefined;
}

/** Validate a parsed config object. Never throws: bad entries are dropped and reported. */
export function normalizeConfig(raw: unknown, knownIds: ReadonlySet<string>, now: Date): LoadedConfig {
  const issues: string[] = [];
  const config: Config = { version: 1, mode: DEFAULT_CONFIG.mode, controls: {}, exceptions: [] };

  if (raw === null || raw === undefined) return { config, issues };
  if (!isRecord(raw)) {
    return { config, issues: ["config must be a mapping; using defaults"] };
  }
  if (raw.version !== undefined && raw.version !== 1) {
    issues.push(`unsupported config version ${JSON.stringify(raw.version)}; expected 1`);
  }
  if (raw.mode !== undefined) {
    if (isMode(raw.mode)) config.mode = raw.mode;
    else issues.push(`mode must be one of ${MODES.join(", ")}; using "${config.mode}"`);
  }
  if (raw.agentContextBudget !== undefined) {
    const n = raw.agentContextBudget;
    if (typeof n === "number" && Number.isFinite(n) && n >= 500 && n <= 20000) config.agentContextBudget = Math.floor(n);
    else issues.push("agentContextBudget must be a number between 500 and 20000");
  }

  if (raw.controls !== undefined) {
    if (!isRecord(raw.controls)) {
      issues.push("controls must be a mapping of control id to mode");
    } else {
      for (const [idRaw, value] of Object.entries(raw.controls)) {
        const id = idRaw.toUpperCase();
        if (!knownIds.has(id)) {
          issues.push(`controls: unknown control ${idRaw}`);
          continue;
        }
        if (isMode(value)) {
          config.controls[id] = { mode: value };
        } else if (isRecord(value)) {
          const entry: { mode?: Mode; disabled?: boolean } = {};
          if (value.mode !== undefined) {
            if (isMode(value.mode)) entry.mode = value.mode;
            else issues.push(`controls.${id}.mode must be one of ${MODES.join(", ")}`);
          }
          if (value.disabled !== undefined) {
            if (typeof value.disabled === "boolean") entry.disabled = value.disabled;
            else issues.push(`controls.${id}.disabled must be true or false`);
          }
          config.controls[id] = entry;
        } else {
          issues.push(`controls.${id} must be a mode string or a mapping`);
        }
      }
    }
  }

  if (raw.exceptions !== undefined) {
    if (!Array.isArray(raw.exceptions)) {
      issues.push("exceptions must be a list");
    } else {
      raw.exceptions.forEach((item: unknown, i: number) => {
        const where = `exceptions[${i}]`;
        if (!isRecord(item)) {
          issues.push(`${where} must be a mapping`);
          return;
        }
        const control = typeof item.control === "string" ? item.control.toUpperCase() : "";
        if (!knownIds.has(control)) {
          issues.push(`${where}: unknown control ${JSON.stringify(item.control)}`);
          return;
        }
        const reason = typeof item.reason === "string" ? item.reason.trim() : "";
        if (!reason) {
          issues.push(`${where} (${control}): a reason is required`);
          return;
        }
        const expires = toIsoDate(item.expires);
        if (!expires) {
          issues.push(`${where} (${control}): expires is required as YYYY-MM-DD; exceptions are always time-boxed`);
          return;
        }
        const horizonDays = Math.floor((new Date(`${expires}T00:00:00Z`).getTime() - now.getTime()) / 86_400_000);
        if (horizonDays > MAX_EXCEPTION_DAYS) {
          issues.push(`${where} (${control}): expires ${expires} is more than ${MAX_EXCEPTION_DAYS} days away; ignored`);
          return;
        }
        const ex: ControlException = { control, reason, expires };
        if (typeof item.owner === "string" && item.owner.trim()) ex.owner = item.owner.trim();
        config.exceptions.push(ex);
      });
    }
  }

  return { config, issues };
}

/** Find and parse a config file from the snapshot. Missing file is normal and yields defaults. */
export async function loadConfig(snapshot: Snapshot, knownIds: ReadonlySet<string>, now: Date): Promise<LoadedConfig> {
  const file = CONFIG_FILES.find((f) => snapshot.paths.includes(f));
  if (!file) return { config: { ...DEFAULT_CONFIG, controls: {}, exceptions: [] }, issues: [] };
  let text: string | null;
  try {
    text = await snapshot.read(file);
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG, controls: {}, exceptions: [] },
      issues: [`${file}: could not be read (${err instanceof Error ? err.message : "error"}); using defaults`],
      source: file
    };
  }
  if (text === null) return { config: { ...DEFAULT_CONFIG, controls: {}, exceptions: [] }, issues: [], source: file };
  let raw: unknown;
  try {
    raw = file.endsWith(".json") ? JSON.parse(stripJsonComments(text)) : parseYaml(text);
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG, controls: {}, exceptions: [] },
      issues: [`${file}: ${err instanceof Error ? err.message : "parse error"}; using defaults`],
      source: file
    };
  }
  const loaded = normalizeConfig(raw, knownIds, now);
  return { ...loaded, issues: loaded.issues.map((m) => `${file}: ${m}`), source: file };
}
