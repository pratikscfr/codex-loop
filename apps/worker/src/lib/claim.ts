/**
 * Cache-or-analyze with the same claim protocol the HTTP route uses, so concurrent callers (several
 * MCP sessions, or MCP racing the web UI) never run duplicate analyses of one repository. Pure:
 * every side effect is injected, which is what makes the concurrency behaviour unit-testable.
 */
import { ApiError } from "./errors.ts";
import type { ClaimResult } from "./types.ts";

export interface ResolveDeps<R> {
  /** Ask the repo agent what to do: serve cache, wait for the running analysis, or start one. */
  claim(id: string): Promise<ClaimResult<R>>;
  analyze(): Promise<R>;
  /** Persist the result and release the claim held under `id`. Returns the report to hand back. */
  save(report: R, id: string): Promise<R>;
  release(id: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  newId(): string;
}

export interface ResolveOptions {
  /** How long to wait for somebody else's in-flight analysis before giving up. */
  timeoutMs: number;
  pollMs: number;
}

export const DEFAULT_RESOLVE_OPTIONS: ResolveOptions = { timeoutMs: 45_000, pollMs: 2_000 };

export async function resolveReport<R>(
  deps: ResolveDeps<R>,
  opts: ResolveOptions = DEFAULT_RESOLVE_OPTIONS
): Promise<{ report: R; cached: boolean }> {
  const deadline = deps.now() + opts.timeoutMs;
  for (;;) {
    const id = deps.newId();
    const claim = await deps.claim(id);
    if (claim.kind === "cached") return { report: claim.report, cached: true };
    if (claim.kind === "claimed") {
      try {
        const report = await deps.analyze();
        return { report: await deps.save(report, id), cached: false };
      } catch (e) {
        await deps.release(id).catch(() => undefined);
        throw e;
      }
    }
    // Somebody else is analyzing this repository: wait for their result instead of duplicating it.
    if (deps.now() >= deadline) {
      throw new ApiError(503, "upstream", "Another analysis of this repository is still running. Try again in a moment.", 5);
    }
    await deps.sleep(opts.pollMs);
  }
}
