/** HTTP API routes (everything under /api/*). Each handler returns a Response or throws an ApiError. */
import { parseRepoInput, renderAgentsMd } from "@codex-loop/core";
import { ApiError, parseWorkflowError } from "./lib/errors.ts";
import { json, methodNotAllowed, text } from "./lib/http.ts";
import { errorInfo, log } from "./lib/log.ts";
import { GLOBAL_RULES, RULES } from "./lib/ratelimit.ts";
import { mapWorkflowStatus } from "./lib/shape.ts";
import type { AnalyzeParams } from "./lib/types.ts";
import {
  checkSameOrigin,
  isValidAnalysisId,
  parseJsonObject,
  parseRepoParams,
  readLimitedText,
  requireJsonContentType,
  validateAnalyzeRequest,
  validateChatRequest,
  validateSessionId
} from "./lib/validate.ts";
import { streamChatAnswer } from "./chat.ts";
import { CACHE_TTL_MS, enforceLimit, repoAgent } from "./service.ts";

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  requestId: string;
}

const REPO_ROUTE = /^\/api\/(report|agents-md|chat)\/([^/]+)\/([^/]+)\/?$/;
const ANALYSIS_ROUTE = /^\/api\/analysis\/([^/]+)\/?$/;

export async function handleApi(rc: RouteContext): Promise<Response> {
  const { request, url } = rc;
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    // No CORS headers on purpose: the API is same-origin only.
    return new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS" } });
  }

  if (path === "/api/analyze" || path === "/api/analyze/") {
    if (request.method !== "POST") return methodNotAllowed(["POST"], rc.requestId);
    return analyze(rc);
  }

  const analysis = ANALYSIS_ROUTE.exec(path);
  if (analysis) {
    if (request.method !== "GET") return methodNotAllowed(["GET"], rc.requestId);
    return analysisStatus(rc, safeDecode(analysis[1]));
  }

  const repoRoute = REPO_ROUTE.exec(path);
  if (repoRoute) {
    const kind = repoRoute[1] as "report" | "agents-md" | "chat";
    const { owner, repo } = parseRepoParams(safeDecode(repoRoute[2]), safeDecode(repoRoute[3]));
    if (kind === "chat") {
      if (request.method === "GET") return chatHistory(rc, owner, repo);
      if (request.method === "POST") return chat(rc, owner, repo);
      return methodNotAllowed(["GET", "POST"], rc.requestId);
    }
    if (request.method !== "GET") return methodNotAllowed(["GET"], rc.requestId);
    return kind === "report" ? report(rc, owner, repo) : agentsMd(rc, owner, repo);
  }

  throw new ApiError(404, "not_found", "No such endpoint.");
}

function safeDecode(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? "");
  } catch {
    throw new ApiError(400, "bad_input", "Malformed URL.");
  }
}

async function readJsonBody(rc: RouteContext): Promise<Record<string, unknown>> {
  checkSameOrigin(rc.request.headers, rc.request.url);
  requireJsonContentType(rc.request.headers.get("content-type"));
  const body = await readLimitedText(rc.request.body, rc.request.headers.get("content-length"));
  return parseJsonObject(body);
}

// ---- POST /api/analyze --------------------------------------------------------------------------

async function analyze(rc: RouteContext): Promise<Response> {
  const body = await readJsonBody(rc);
  const { owner, repo } = validateAnalyzeRequest(body, parseRepoInput);
  const label = `${owner}/${repo}`;

  // Cheap first gate: meter the request BEFORE any per-repo Durable Object is created or woken, so
  // cache hits and probes for random owner/repo names are counted too.
  await enforceLimit(rc.env, rc.request.headers, RULES.read);

  const agent = await repoAgent(rc.env, owner, repo);
  // Cache hits never start a workflow, so they skip the (stricter) analyze budget below.
  const fresh = await agent.getFreshReport(CACHE_TTL_MS, "", true);
  if (fresh) return json({ cached: true, repo: label, report: fresh }, rc.requestId);

  const limitHeaders = await enforceLimit(rc.env, rc.request.headers, RULES.analyze, GLOBAL_RULES.analyze);

  const id = crypto.randomUUID();
  const claim = await agent.claimAnalysis(id, "", CACHE_TTL_MS, true);
  if (claim.kind === "cached") return json({ cached: true, repo: label, report: claim.report }, rc.requestId);
  if (claim.kind === "inflight") {
    return json({ id: claim.id, repo: label, deduped: true }, rc.requestId, { status: 202, headers: limitHeaders });
  }

  const params: AnalyzeParams = { owner, repo, requestedRef: "", analysisId: id };
  try {
    await rc.env.ANALYZE_WORKFLOW.create({ id, params });
  } catch (e) {
    await agent.releaseAnalysis(id).catch(() => undefined);
    log("error", "workflow_create_failed", { requestId: rc.requestId, ...errorInfo(e) });
    throw new ApiError(503, "upstream", "Could not start the analysis. Please try again shortly.", 5);
  }
  log("info", "analysis_started", { requestId: rc.requestId, analysisId: id, repo: label });
  return json({ id, repo: label }, rc.requestId, { status: 202, headers: limitHeaders });
}

// ---- GET /api/analysis/:id ----------------------------------------------------------------------

async function analysisStatus(rc: RouteContext, id: string): Promise<Response> {
  if (!isValidAnalysisId(id)) throw new ApiError(400, "bad_input", "Invalid analysis id.");
  let instance: WorkflowInstance;
  try {
    instance = await rc.env.ANALYZE_WORKFLOW.get(id);
  } catch {
    throw new ApiError(404, "not_found", "Unknown analysis id (it may have expired).");
  }
  const s = await instance.status();
  const status = mapWorkflowStatus(s.status);
  const body: { id: string; status: string; error?: { code: string; message: string; retryAfterSeconds?: number } } = {
    id,
    status
  };
  if (status === "errored") {
    body.error = parseWorkflowError(s.error);
    log("info", "analysis_errored", {
      requestId: rc.requestId,
      analysisId: id,
      code: body.error.code,
      workflowError: { name: s.error?.name, message: (s.error?.message ?? "").slice(0, 300) }
    });
  }
  else if (status === "terminated") body.error = { code: "internal", message: "The analysis was cancelled." };
  return json(body, rc.requestId);
}

// ---- GET /api/report/:owner/:repo ----------------------------------------------------------------

async function report(rc: RouteContext, owner: string, repo: string): Promise<Response> {
  await enforceLimit(rc.env, rc.request.headers, RULES.read);
  const agent = await repoAgent(rc.env, owner, repo);
  const bundle = await agent.getBundle();
  if (!bundle) throw new ApiError(404, "not_analyzed", `${owner}/${repo} has not been analyzed yet.`);
  return json({ report: bundle.report, history: bundle.history }, rc.requestId);
}

// ---- GET /api/agents-md/:owner/:repo -------------------------------------------------------------

async function agentsMd(rc: RouteContext, owner: string, repo: string): Promise<Response> {
  await enforceLimit(rc.env, rc.request.headers, RULES.read);
  const agent = await repoAgent(rc.env, owner, repo);
  const stored = await agent.getReport();
  if (!stored) throw new ApiError(404, "not_analyzed", `${owner}/${repo} has not been analyzed yet.`);
  return text(renderAgentsMd(stored), rc.requestId, "text/markdown; charset=utf-8", {
    headers: { "Content-Disposition": 'inline; filename="AGENTS.md"' }
  });
}

// ---- /api/chat/:owner/:repo ----------------------------------------------------------------------

async function chatHistory(rc: RouteContext, owner: string, repo: string): Promise<Response> {
  const sessionId = validateSessionId(rc.request.headers.get("x-session-id"));
  await enforceLimit(rc.env, rc.request.headers, RULES.read);
  const agent = await repoAgent(rc.env, owner, repo);
  // Only this browser session's own turns are ever returned.
  return json({ messages: await agent.getChat(sessionId) }, rc.requestId);
}

async function chat(rc: RouteContext, owner: string, repo: string): Promise<Response> {
  const body = await readJsonBody(rc);
  const { message } = validateChatRequest(body);
  const sessionId = validateSessionId(rc.request.headers.get("x-session-id"));
  await enforceLimit(rc.env, rc.request.headers, RULES.read);
  const agent = await repoAgent(rc.env, owner, repo);
  const stored = await agent.getReport();
  if (!stored) {
    throw new ApiError(409, "not_analyzed", `${owner}/${repo} has not been analyzed yet. Analyze it first, then ask questions.`);
  }
  await enforceLimit(rc.env, rc.request.headers, RULES.chat, GLOBAL_RULES.chat);
  const history = await agent.getChat(sessionId);
  return streamChatAnswer({
    env: rc.env,
    ctx: rc.ctx,
    agent,
    sessionId,
    owner,
    repo,
    report: stored,
    history,
    message,
    requestId: rc.requestId
  });
}
