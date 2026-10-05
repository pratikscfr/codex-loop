/** Small, dependency-free helpers shared by profiling and controls. */

/** Paths we never treat as the project's own code (dependencies, build output, VCS). */
export const VENDORED =
  /(^|\/)(node_modules|vendor|third_party|\.git|dist|build|target|\.next|\.nuxt|\.venv|venv|__pycache__|\.wrangler|\.terraform|Pods)\//;

/** Paths that are tests, docs or samples; some controls deliberately ignore them. */
export const NON_PROD = /(^|\/)(test|tests|__tests__|spec|fixtures?|testdata|examples?|docs?|e2e|samples?|benchmarks?)\//i;

export function isVendored(path: string): boolean {
  return VENDORED.test(path);
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Directory of a path; "" for the repo root. */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** "a/b/c" becomes ["a/b/c", "a/b", "a", ""] (nearest first, root last). */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  for (;;) {
    out.push(cur);
    if (cur === "") break;
    cur = dirname(cur);
  }
  return out;
}

export function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** 1-based line number of a character offset. */
export function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function todayUTC(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/** Limit evidence lists so reports stay readable; adds a trailing "and N more". */
export function capList<T>(items: T[], max: number, more: (n: number) => T): T[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), more(items.length - max)];
}

/**
 * Strip line comments, block comments and trailing commas so JSONC (tsconfig, wrangler.jsonc) parses.
 * String-aware: a URL like "http://x" or comment-looking text inside a string is preserved.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === ",") {
      // Look ahead past whitespace/comments: drop the comma if the next token closes a container.
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j]!)) j++;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < n && text[j] !== "\n") j++;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "*") {
          j += 2;
          while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseJsonc<T = unknown>(text: string): T | undefined {
  try {
    // A UTF-8 BOM would make JSON.parse throw.
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return JSON.parse(stripJsonComments(clean)) as T;
  } catch {
    return undefined;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Case-insensitive membership test on a set of root-level file names. */
export function hasRootFile(paths: readonly string[], names: readonly string[]): string | undefined {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return paths.find((p) => !p.includes("/") && lower.has(p.toLowerCase()));
}

export function findPaths(paths: readonly string[], re: RegExp): string[] {
  return paths.filter((p) => re.test(p));
}
