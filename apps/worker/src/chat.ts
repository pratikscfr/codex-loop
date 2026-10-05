import { createWorkersAI } from "workers-ai-provider";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { findControl, renderAgentsMd, type Report } from "@codex-loop/core";
import { ApiError } from "./lib/errors.ts";
import { buildChatSystemPrompt, buildModelMessages } from "./lib/chat-prompt.ts";
import { streamResponse } from "./lib/http.ts";
import { errorInfo, log } from "./lib/log.ts";
import { capToolResult, controlView, footprintView, liveFailures, summarizeReport } from "./lib/shape.ts";
import { openTextStream } from "./lib/stream.ts";
import type { ChatMessage } from "./lib/types.ts";
import type { RepoAgent } from "./repo-agent.ts";
import { modelId } from "./service.ts";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

/** Tools over the stored report. They are the only source of facts the model is allowed to use. */
export function buildChatTools(report: Report) {
  return {
    get_summary: tool({
      description:
        "Overall result for the repository: pass/fail/unknown counts, severity breakdown, coverage, and the live failing controls with short evidence.",
      inputSchema: z.object({}),
      execute: async () => capToolResult(summarizeReport(report))
    }),
    list_failures: tool({
      description: "List live failing controls (not suppressed by an exception), most severe first. Optionally filter by severity.",
      inputSchema: z.object({
        severity: z.enum(SEVERITIES).nullish().describe("Only return failures of this severity")
      }),
      execute: async ({ severity }) => {
        const failures = liveFailures(report, severity ?? undefined);
        return capToolResult({ total: failures.length, failures: failures.slice(0, 30).map((r) => controlView(r, 3)) });
      }
    }),
    get_control: tool({
      description:
        "Details for one control id (for example CDX-021): its result for this repository, the rationale, the remediation and evidence.",
      inputSchema: z.object({ id: z.string().min(1).max(40).describe("Control id, e.g. CDX-021") }),
      execute: async ({ id }) => {
        const wanted = id.trim().toUpperCase();
        const result = report.results.find((r) => r.id.toUpperCase() === wanted);
        const definition = findControl(wanted);
        if (!result && !definition) return { found: false, message: `No control with id ${wanted} exists.` };
        return capToolResult({
          found: true,
          result: result ? controlView(result, 8) : null,
          ...(result
            ? {}
            : { note: "This control exists but produced no result in this report (it may not apply to this repository)." }),
          ...(definition ? { agentRule: definition.agentRule } : {})
        });
      }
    }),
    get_agents_md: tool({
      description: "The AGENTS.md context generated for this repository from its failing controls (what a coding agent should follow).",
      inputSchema: z.object({}),
      execute: async () => capToolResult({ markdown: renderAgentsMd(report, { maxChars: 6000 }) })
    }),
    get_footprint: tool({
      description:
        "Agent footprint: how many recent pull requests were authored by AI agents, automation or unknown, with median hours to merge. Includes a caveat that must be repeated when quoting numbers.",
      inputSchema: z.object({}),
      execute: async () => capToolResult(footprintView(report.footprint))
    })
  };
}

export interface ChatRequestContext {
  env: Env;
  ctx: ExecutionContext;
  agent: DurableObjectStub<RepoAgent>;
  sessionId: string;
  owner: string;
  repo: string;
  report: Report;
  history: ChatMessage[];
  message: string;
  requestId: string;
}

/**
 * Stream a grounded answer as plain text. Resolves to a 503 ApiError (not a half-open 200) when the
 * AI binding or model fails before producing anything. The exchange is persisted only once the
 * model has finished, even if the browser disconnects mid-stream.
 */
export async function streamChatAnswer(c: ChatRequestContext): Promise<Response> {
  let parts: AsyncIterable<{ type: string; text?: string; error?: unknown }>;
  try {
    const workersai = createWorkersAI({ binding: c.env.AI });
    const result = streamText({
      model: workersai(modelId(c.env)),
      system: buildChatSystemPrompt(c.owner, c.repo),
      messages: buildModelMessages(c.history, c.message),
      tools: buildChatTools(c.report),
      stopWhen: stepCountIs(5),
      temperature: 0.2,
      maxOutputTokens: 900,
      maxRetries: 1,
      // Deliberately not tied to the request: the exchange is still persisted if the browser leaves.
      abortSignal: AbortSignal.timeout(60_000),
      onError: ({ error }) => log("warn", "chat_stream_error", { requestId: c.requestId, ...errorInfo(error) })
    });
    parts = result.fullStream as AsyncIterable<{ type: string; text?: string; error?: unknown }>;
  } catch (e) {
    log("warn", "chat_model_unavailable", { requestId: c.requestId, ...errorInfo(e) });
    throw new ApiError(503, "ai_unavailable", "The AI model is unavailable right now. Please try again shortly.");
  }

  const opened = await openTextStream(parts);
  if (!opened.ok) {
    log("warn", "chat_no_answer", { requestId: c.requestId, reason: opened.reason, ...(opened.error ? errorInfo(opened.error) : {}) });
    throw new ApiError(
      503,
      "ai_unavailable",
      opened.reason === "empty"
        ? "The AI model returned no answer. Please rephrase and try again."
        : "The AI model is unavailable right now. Please try again shortly."
    );
  }

  c.ctx.waitUntil(
    opened.done.then(async ({ text, error, finished }) => {
      if (error !== undefined || !finished) {
        // Interrupted / aborted / cut off: never store a truncated answer as if it were complete.
        log("warn", "chat_incomplete", { requestId: c.requestId, ...(error !== undefined ? errorInfo(error) : {}) });
        return;
      }
      try {
        await c.agent.appendChat(c.sessionId, [
          { role: "user", content: c.message },
          { role: "assistant", content: text }
        ]);
      } catch (e) {
        log("warn", "chat_persist_failed", { requestId: c.requestId, ...errorInfo(e) });
      }
    })
  );

  return streamResponse(opened.stream, c.requestId, "text/plain; charset=utf-8");
}
