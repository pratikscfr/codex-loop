/**
 * Runtime glue shared by the HTTP routes, the workflow and the MCP server: agent lookup, GitHub
 * options, rate-limit enforcement and the cache-or-analyze helper.
 */
import { getAgentByName } from "agents";
import { analyzeGitHubRepo, type GitHubOptions, type Report } from "@codex-loop/core";
import { resolveReport } from "./lib/claim.ts";
import { ApiError } from "./lib/errors.ts";
import { log } from "./lib/log.ts";
import { clientKey, rateLimitHeaders, type RateRule } from "./lib/ratelimit.ts";
import { sanitizeReport } from "./lib/shape.ts";
import { repoKey } from "./lib/validate.ts";
import type { RepoAgent } from "./repo-agent.ts";

/** A stored report younger than this is served instead of re-analyzing. */
export const CACHE_TTL_MS = 15 * 60_000;
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function modelId(env: Env): string {
  return env.CHAT_MODEL && env.CHAT_MODEL.trim() ? env.CHAT_MODEL.trim() : DEFAULT_MODEL;
}

export function githubOptions(env: Env): GitHubOptions {
  const opts: GitHubOptions = {};
  if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()) opts.token = env.GITHUB_TOKEN.trim();
  const max = Number(env.MAX_FILE_READS);
  if (Number.isInteger(max) && max > 0) opts.maxFileReads = max;
  // Test seam for a local mock of GitHub; deployers never set these in production.
  if (env.GITHUB_API_BASE) opts.apiBase = env.GITHUB_API_BASE;
  if (env.GITHUB_RAW_BASE) opts.rawBase = env.GITHUB_RAW_BASE;
  return opts;
}

export function repoAgent(env: Env, owner: string, repo: string) {
  return getAgentByName<Env, RepoAgent>(env.RepoAgent, repoKey(owner, repo));
}

async function hitLimiter(env: Env, name: string, rule: RateRule, weight: number) {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
  return stub.hit(rule.bucket, rule.limit, rule.windowSeconds, weight);
}

/**
 * Enforce a per-client rule (and optionally a global one). Fails open if the limiter itself is
 * unavailable: an outage there must not take the whole site down.
 */
export async function enforceLimit(
  env: Env,
  headers: Headers,
  rule: RateRule,
  globalRule?: RateRule,
  weight = 1
): Promise<Record<string, string>> {
  try {
    const key = await clientKey(headers);
    const perClient = await hitLimiter(env, key, rule, weight);
    if (!perClient.allowed) {
      throw new ApiError(
        429,
        "rate_limited",
        `Rate limit reached (${rule.limit} per hour). Try again in ${Math.ceil(perClient.retryAfterSeconds / 60)} minute(s).`,
        perClient.retryAfterSeconds
      );
    }
    if (globalRule) {
      const global = await hitLimiter(env, "global", globalRule, weight);
      if (!global.allowed) {
        throw new ApiError(
          429,
          "rate_limited",
          "The service is busy right now. Please try again in a few minutes.",
          Math.min(global.retryAfterSeconds, 600)
        );
      }
    }
    return rateLimitHeaders(perClient);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    log("warn", "rate_limiter_unavailable", { message: e instanceof Error ? e.message : "unknown" });
    return {};
  }
}

/**
 * Serve a fresh cached report, or analyze inline and store the result. Used by the MCP server.
 * Goes through the same claim protocol as POST /api/analyze, so concurrent callers for one
 * repository share a single analysis instead of each burning GitHub quota.
 */
export async function getOrAnalyze(env: Env, owner: string, repo: string): Promise<{ report: Report; cached: boolean }> {
  const agent = await repoAgent(env, owner, repo);
  return resolveReport<Report>({
    // touch = true: an MCP tool call is a user view (keeps the daily refresh alive).
    claim: (id) => agent.claimAnalysis(id, "", CACHE_TTL_MS, true),
    analyze: async () =>
      sanitizeReport(await analyzeGitHubRepo({ owner, repo, includeFootprint: true }, githubOptions(env))),
    save: async (report, id) => {
      await agent.saveReport(report, "", id);
      return report;
    },
    release: (id) => agent.releaseAnalysis(id),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    newId: () => crypto.randomUUID()
  });
}
