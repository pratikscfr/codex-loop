import type { Snapshot } from "./types.ts";

/** Thrown by a budgeted snapshot when more file reads are requested than allowed. */
export class ReadBudgetExceeded extends Error {
  constructor(public budget: number) {
    super(`file read budget of ${budget} exhausted`);
    this.name = "ReadBudgetExceeded";
  }
}

export interface LazySnapshotInit {
  paths: readonly string[];
  /** Fetch one file's text; return null when missing, binary or too large. */
  load(path: string): Promise<string | null>;
  truncated?: boolean;
  /** Max distinct files that may be loaded. Omit for unlimited (local disk). */
  maxFileReads?: number;
  /** Concurrent loads during prefetch. */
  concurrency?: number;
}

export interface BudgetedSnapshot extends Snapshot {
  /** Load many files concurrently so later `read` calls are cache hits. Respects the budget. */
  prefetch(paths: readonly string[]): Promise<void>;
  /** Files still allowed to be read (Infinity when unlimited). */
  remainingBudget(): number;
}

export function createLazySnapshot(init: LazySnapshotInit): BudgetedSnapshot {
  const cache = new Map<string, Promise<string | null>>();
  const limit = init.maxFileReads ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.max(1, init.concurrency ?? 6);
  const pathSet = new Set(init.paths);

  const start = (path: string): Promise<string | null> => {
    let p = cache.get(path);
    if (!p) {
      if (cache.size >= limit) throw new ReadBudgetExceeded(limit);
      p = init.load(path).catch((err) => {
        cache.delete(path);
        throw err;
      });
      cache.set(path, p);
    }
    return p;
  };

  return {
    paths: init.paths,
    truncated: init.truncated ?? false,
    filesRead: () => cache.size,
    remainingBudget: () => Math.max(0, limit - cache.size),
    async read(path) {
      // Never hit the network for paths that are not in the tree.
      if (!pathSet.has(path)) return null;
      return start(path);
    },
    async prefetch(paths) {
      const wanted = [...new Set(paths)].filter((p) => pathSet.has(p) && !cache.has(p));
      let next = 0;
      const worker = async () => {
        while (next < wanted.length) {
          const path = wanted[next++]!;
          if (cache.size >= limit) return;
          try {
            await start(path);
          } catch (err) {
            if (err instanceof ReadBudgetExceeded) return;
            // Other failures surface on the real `read` call that needs the file.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
    }
  };
}

/** In-memory snapshot used by tests and by callers that already hold file contents. */
export function createMemorySnapshot(
  files: Record<string, string>,
  opts: { truncated?: boolean; maxFileReads?: number } = {}
): BudgetedSnapshot {
  return createLazySnapshot({
    paths: Object.keys(files),
    load: async (p) => files[p] ?? null,
    truncated: opts.truncated,
    maxFileReads: opts.maxFileReads
  });
}

/** Snapshot helpers that tolerate snapshots without prefetch support. */
export async function prefetch(snapshot: Snapshot, paths: readonly string[]): Promise<void> {
  const s = snapshot as Partial<BudgetedSnapshot>;
  if (typeof s.prefetch === "function") await s.prefetch(paths);
}

export function remainingBudget(snapshot: Snapshot): number {
  const s = snapshot as Partial<BudgetedSnapshot>;
  return typeof s.remainingBudget === "function" ? s.remainingBudget() : Number.POSITIVE_INFINITY;
}
