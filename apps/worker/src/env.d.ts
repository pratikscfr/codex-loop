/**
 * Hand-written binding types (kept in sync with wrangler.jsonc). The Agents SDK reads
 * `Cloudflare.Env`, so the bindings live in that namespace and `Env` extends it.
 */
declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    RepoAgent: DurableObjectNamespace<import("./repo-agent.ts").RepoAgent>;
    MCP_OBJECT: DurableObjectNamespace<import("./mcp.ts").CodexLoopMcp>;
    RATE_LIMITER: DurableObjectNamespace<import("./rate-limiter.ts").RateLimiter>;
    ANALYZE_WORKFLOW: Workflow<import("./lib/types.ts").AnalyzeParams>;
    /** Workers AI model id. */
    CHAT_MODEL?: string;
    /** Optional GitHub token (secret). Raises the GitHub API rate limit; public repos only. */
    GITHUB_TOKEN?: string;
    /** Optional comma-separated origins allowed to call /mcp from a browser (default: none, no CORS). */
    MCP_ALLOWED_ORIGINS?: string;
    /** Optional cap on files fetched per analysis (useful on the Workers Free subrequest limit). */
    MAX_FILE_READS?: string;
    /** Test seam only: base URLs of a mock GitHub (see scripts/mock-github.mjs). Leave unset in production. */
    GITHUB_API_BASE?: string;
    GITHUB_RAW_BASE?: string;
  }
}

interface Env extends Cloudflare.Env {}
