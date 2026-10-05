import { analyze } from "./engine.ts";
import { summarizeFootprint, type PullRequestInput } from "./footprint.ts";
import { createLazySnapshot } from "./snapshot.ts";
import type { Report } from "./types.ts";

export type GitHubErrorKind = "bad_input" | "not_found" | "rate_limited" | "forbidden" | "empty" | "upstream";

export class GitHubError extends Error {
  /**
   * True for failures worth retrying (rate limits, network/5xx). The engine re-throws these instead
   * of turning them into "unknown" results, so a flaky fetch can never be stored as a finished report.
   */
  readonly transient: boolean;

  constructor(
    public kind: GitHubErrorKind,
    message: string,
    public status?: number,
    public retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "GitHubError";
    this.transient = kind === "rate_limited" || kind === "upstream";
  }
}

export interface GitHubOptions {
  /** Optional token to raise API rate limits. Only ever used to read public repositories. */
  token?: string;
  fetch?: typeof fetch;
  now?: Date;
  /**
   * Upper bound on distinct files fetched for content checks. The default keeps a full analysis
   * (4 API calls + reads) under the 50-subrequest limit of a Workers Free invocation.
   */
  maxFileReads?: number;
  timeoutMs?: number;
  /**
   * Test seam: alternative base URLs (for a local mock of GitHub). Only ever set by the deployer or a test,
   * never from request data. The token is still sent only to `apiBase`.
   */
  apiBase?: string;
  rawBase?: string;
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9._/@-]{1,200}$/;
export const MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_FILE_READS = 40;

function validName(s: string): boolean {
  return NAME.test(s) && s !== "." && s !== "..";
}

/** Accepts "owner/repo", https://github.com/owner/repo(.git)(/tree/...), and git@github.com:owner/repo.git. */
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  if (!s || s.length > 300) return null;
  let owner: string | undefined;
  let repo: string | undefined;

  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s);
  if (ssh) {
    owner = ssh[1];
    repo = ssh[2];
  } else if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    owner = parts[0];
    repo = parts[1]?.replace(/\.git$/i, "");
  } else {
    const m = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(s);
    if (m) {
      owner = m[1];
      repo = m[2];
    }
  }
  if (!owner || !repo || !validName(owner) || !validName(repo)) return null;
  return { owner, repo };
}

function retryAfter(res: Response): number | undefined {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(3600, Math.ceil(header));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(3600, Math.max(1, Math.ceil(reset - Date.now() / 1000)));
  return undefined;
}

async function toError(res: Response, what: string): Promise<GitHubError> {
  let message = "";
  try {
    const body: unknown = await res.clone().json();
    if (typeof body === "object" && body !== null && "message" in body) message = String((body as { message: unknown }).message);
  } catch {
    /* non-JSON body */
  }
  const limited =
    res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit|abuse|too many/i.test(message)));
  if (limited) return new GitHubError("rate_limited", "GitHub rate limit reached; try again shortly.", res.status, retryAfter(res) ?? 60);
  if (res.status === 404) return new GitHubError("not_found", `${what} not found (the repository must exist and be public).`, 404);
  if (res.status === 409) return new GitHubError("empty", "The repository is empty.", 409);
  if (res.status === 451) return new GitHubError("forbidden", "The repository is unavailable for legal reasons.", 451);
  if (res.status === 403 || res.status === 401) return new GitHubError("forbidden", "GitHub denied access to this repository.", res.status);
  if (res.status === 422) return new GitHubError("not_found", `${what} could not be resolved.`, 422);
  return new GitHubError("upstream", `GitHub returned ${res.status} while fetching ${what}.`, res.status);
}

interface Ctx {
  f: typeof fetch;
  token?: string;
  timeoutMs: number;
  apiBase: string;
}

async function request(ctx: Ctx, url: string, accept: string, withToken = true): Promise<Response> {
  const headers: Record<string, string> = { accept, "user-agent": "codex-loop", "x-github-api-version": "2022-11-28" };
  if (withToken && ctx.token && url.startsWith(ctx.apiBase)) headers.authorization = `Bearer ${ctx.token}`;
  try {
    const res = await ctx.f(url, { headers, signal: AbortSignal.timeout(ctx.timeoutMs) });
    // A revoked token must not break analysis of public repositories: retry anonymously once.
    if (res.status === 401 && withToken && ctx.token) return request(ctx, url, accept, false);
    return res;
  } catch (err) {
    throw new GitHubError("upstream", `Could not reach GitHub (${err instanceof Error ? err.name : "network error"}).`);
  }
}

async function apiJson<T>(ctx: Ctx, path: string, what: string): Promise<T> {
  const res = await request(ctx, `${ctx.apiBase}${path}`, "application/vnd.github+json");
  if (!res.ok) throw await toError(res, what);
  try {
    return (await res.json()) as T;
  } catch {
    throw new GitHubError("upstream", `GitHub returned an unreadable response for ${what}.`);
  }
}

interface RepoMeta {
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  html_url: string;
}
interface TreeResponse {
  tree: Array<{ path: string; type: string; mode?: string; size?: number }>;
  truncated: boolean;
}

export async function analyzeGitHubRepo(
  input: { owner: string; repo: string; ref?: string; includeFootprint?: boolean },
  opts: GitHubOptions = {}
): Promise<Report> {
  if (!validName(input.owner) || !validName(input.repo)) throw new GitHubError("bad_input", "Invalid repository name.");
  if (input.ref !== undefined && (!REF.test(input.ref) || input.ref.includes(".."))) throw new GitHubError("bad_input", "Invalid ref.");

  const cleanBase = (value: string | undefined, fallback: string): string => {
    if (!value) return fallback;
    if (!/^https?:\/\/[^\s?#]+$/.test(value)) throw new GitHubError("bad_input", "Invalid GitHub base URL override.");
    return value.replace(/\/+$/, "");
  };
  const ctx: Ctx = {
    f: opts.fetch ?? ((url, init) => fetch(url, init)),
    token: opts.token || undefined,
    timeoutMs: opts.timeoutMs ?? 15_000,
    apiBase: cleanBase(opts.apiBase, API)
  };
  const rawRoot = cleanBase(opts.rawBase, RAW);
  const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;

  const meta = await apiJson<RepoMeta>(ctx, base, "Repository");
  // The service token must never be a way to read a private repository.
  if (meta.private) throw new GitHubError("forbidden", "Only public repositories can be analyzed.");
  const ref = input.ref ?? meta.default_branch;

  const shaRes = await request(ctx, `${ctx.apiBase}${base}/commits/${encodeURIComponent(ref).replace(/%2F/g, "/")}`, "application/vnd.github.sha");
  if (!shaRes.ok) throw await toError(shaRes, "Branch or commit");
  const sha = (await shaRes.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new GitHubError("upstream", "GitHub returned an unexpected commit identifier.");

  const treeData = await apiJson<TreeResponse>(ctx, `${base}/git/trees/${sha}?recursive=1`, "File tree");
  const blobs = (treeData.tree ?? []).filter((e) => e.type === "blob" && e.mode !== "120000");
  if (blobs.length === 0) throw new GitHubError("empty", "The repository has no files at this ref.");
  const sizes = new Map(blobs.map((b) => [b.path, b.size ?? 0]));

  const owner = meta.owner.login;
  const repo = meta.name;
  const rawBase = `${rawRoot}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}`;

  const snapshot = createLazySnapshot({
    paths: blobs.map((b) => b.path),
    truncated: treeData.truncated === true,
    maxFileReads: opts.maxFileReads ?? DEFAULT_MAX_FILE_READS,
    concurrency: 6,
    async load(path) {
      if ((sizes.get(path) ?? 0) > MAX_FILE_BYTES) return null;
      const url = `${rawBase}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const res = await request(ctx, url, "text/plain", false);
      if (res.status === 404) return null;
      if (!res.ok) throw await toError(res, path);
      const text = await res.text();
      // Binary files are not useful to text checks (NUL bytes in the first 8KB).
      return text.slice(0, 8000).includes("\u0000") ? null : text;
    }
  });

  const report = await analyze(snapshot, {
    now: opts.now,
    repo: { owner, repo, ref, sha, url: meta.html_url }
  });

  if (input.includeFootprint) {
    try {
      const prs = await apiJson<PullRequestInput[]>(ctx, `${base}/pulls?state=closed&per_page=100&sort=updated&direction=desc`, "Pull requests");
      if (Array.isArray(prs) && prs.length > 0) report.footprint = summarizeFootprint(prs, opts.now ?? new Date());
    } catch {
      /* The footprint is a bonus view; never fail the whole analysis for it. */
    }
  }
  return report;
}
