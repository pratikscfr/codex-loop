import { ApiError } from "./lib/errors.ts";
import { errorResponse, json, newRequestId } from "./lib/http.ts";
import { errorInfo, log } from "./lib/log.ts";
import { applyMcpCors, parseAllowList, planMcpCharges, rpcIdOf } from "./lib/mcp-limits.ts";
import { GLOBAL_RULES, RULES } from "./lib/ratelimit.ts";
import { readLimitedText } from "./lib/validate.ts";
import { ANALYZING_TOOLS, CodexLoopMcp } from "./mcp.ts";
import { handleApi } from "./routes.ts";
import { enforceLimit } from "./service.ts";

// Durable Object / Workflow classes must be exported from the entry module.
export { RepoAgent } from "./repo-agent.ts";
export { RateLimiter } from "./rate-limiter.ts";
export { AnalyzeRepoWorkflow } from "./workflow.ts";
export { CodexLoopMcp };

const MCP_MAX_BODY_BYTES = 32 * 1024;
const mcpHandler = CodexLoopMcp.serve("/mcp", { binding: "MCP_OBJECT" });

function rpcError(
  status: number,
  id: string | number | null,
  rpcCode: number,
  message: string,
  requestId: string,
  retryAfterSeconds?: number
): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Request-Id": requestId };
  if (retryAfterSeconds !== undefined) headers["Retry-After"] = String(retryAfterSeconds);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: rpcCode, message } }), { status, headers });
}

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  let forwarded = request;
  let rpcId: string | number | null = null;
  try {
    if (request.method === "POST") {
      // Bound the body, then charge per billable operation: a JSON-RPC batch must pay for every
      // analysis / session it contains, not one hit for the whole HTTP request.
      const body = await readLimitedText(request.body, request.headers.get("content-length"), MCP_MAX_BODY_BYTES);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = undefined; // the MCP transport will reject malformed JSON itself
      }
      rpcId = rpcIdOf(payload);
      const plan = planMcpCharges(payload, ANALYZING_TOOLS);
      if (plan.reject) return rpcError(plan.reject.status, rpcId, plan.reject.rpcCode, plan.reject.message, requestId);
      if (plan.initializeHits > 0) await enforceLimit(env, request.headers, RULES.read, undefined, plan.initializeHits);
      if (plan.analyzeHits > 0) {
        await enforceLimit(env, request.headers, RULES.analyze, GLOBAL_RULES.analyze, plan.analyzeHits);
      }
      // The body was re-encoded from text, so let the runtime recompute Content-Length.
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      forwarded = new Request(request.url, { method: "POST", headers, body });
    } else if (request.method === "GET") {
      // Opening the server-to-client stream attaches to (or creates) a session: meter it.
      await enforceLimit(env, request.headers, RULES.read);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      return rpcError(429, rpcId, -32000, e.message, requestId, e.retryAfterSeconds ?? 60);
    }
    throw e;
  }
  const res = await mcpHandler.fetch(forwarded, env, ctx);
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  // No CORS unless the operator explicitly allow-lists origins (MCP clients are not browsers).
  applyMcpCors(out.headers, request.headers.get("origin"), parseAllowList(env.MCP_ALLOWED_ORIGINS));
  out.headers.set("X-Request-Id", requestId);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Cache-Control", "no-store");
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const started = Date.now();
    const url = new URL(request.url);
    let response: Response;
    let failure: ApiError | undefined;

    try {
      if (url.pathname === "/healthz") {
        response =
          request.method === "GET" || request.method === "HEAD"
            ? json({ status: "ok" }, requestId)
            : errorResponse(new ApiError(405, "method_not_allowed", "Use GET."), requestId).response;
      } else if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        response = await handleMcp(request, env, ctx, requestId);
      } else if (url.pathname.startsWith("/api/")) {
        response = await handleApi({ request, env, ctx, url, requestId });
      } else {
        throw new ApiError(404, "not_found", "Not found.");
      }
    } catch (e) {
      const r = errorResponse(e, requestId);
      response = r.response;
      failure = r.error;
      if (r.error.status >= 500 && r.error.code === "internal") {
        log("error", "unhandled_error", { requestId, path: url.pathname, ...errorInfo(e) });
      }
    }

    log(failure && failure.status >= 500 ? "warn" : "info", "request", {
      requestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      ms: Date.now() - started,
      ...(failure ? { code: failure.code } : {})
    });
    return response;
  }
} satisfies ExportedHandler<Env>;

