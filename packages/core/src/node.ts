/** Node-only adapters. Kept out of the main entry so Worker bundles never pull in node:fs. */
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createLazySnapshot, type BudgetedSnapshot } from "./snapshot.ts";
import { VENDORED } from "./util.ts";

const run = promisify(execFile);
const MAX_LOCAL_FILES = 200_000;

async function gitList(root: string): Promise<string[] | null> {
  try {
    const opts = { cwd: root, maxBuffer: 256 * 1024 * 1024 };
    const [listed, deleted] = await Promise.all([
      run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], opts),
      run("git", ["ls-files", "-z", "--deleted"], opts)
    ]);
    const gone = new Set(deleted.stdout.split("\0").filter(Boolean));
    const files = listed.stdout.split("\0").filter((p) => p && !gone.has(p));
    return [...new Set(files)];
  } catch {
    return null; // not a git repository, or git is unavailable
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_LOCAL_FILES) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!VENDORED.test(`${child}/`)) stack.push(child);
      } else if (e.isFile()) out.push(child);
    }
  }
  return out;
}

export interface DirectorySnapshotOptions {
  /** Files larger than this are treated as unreadable. */
  maxFileBytes?: number;
}

export async function createDirectorySnapshot(dir: string, opts: DirectorySnapshotOptions = {}): Promise<BudgetedSnapshot> {
  const root = await realpath(dir);
  const maxBytes = opts.maxFileBytes ?? 512 * 1024;
  const paths = ((await gitList(root)) ?? (await walk(root))).map((p) => p.split(path.sep).join("/")).sort();

  return createLazySnapshot({
    paths,
    truncated: paths.length >= MAX_LOCAL_FILES,
    async load(rel) {
      if (rel.split("/").includes("..") || path.isAbsolute(rel)) return null;
      const full = path.join(root, rel);
      try {
        const st = await lstat(full);
        // Never follow a symlink: it could point outside the repository being checked.
        if (!st.isFile() || st.size > maxBytes) return null;
        const buf = await readFile(full);
        if (buf.subarray(0, 8000).includes(0)) return null;
        return buf.toString("utf8");
      } catch {
        return null;
      }
    }
  });
}
