import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONTROLS, findControl, parseRepoInput, renderAgentsMd } from "@codex-loop/core";
import { ApiError, isGitHubErrorLike, mapGitHubError, safeMessage } from "./lib/errors.ts";
import { errorInfo, log } from "./lib/log.ts";
import { summarizeReport } from "./lib/shape.ts";
import { validateAnalyzeRequest } from "./lib/validate.ts";
import { getOrAnalyze } from "./service.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]
});
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const RepoArg = z
  .string()
  .min(1)
  .max(300)
  .describe('Public GitHub repository as "owner/name" or a https://github.com/owner/name URL');

/** Tool names that may trigger a (rate-limited) analysis. Kept in sync with the fetch-level limiter. */
export const ANALYZING_TOOLS: ReadonlySet<string> = new Set(["analyze_repository", "get_agent_context"]);

/**
 * Public, read-only remote MCP server (Streamable HTTP at /mcp, no authentication). Tools only
 * read public GitHub data and the deterministic codex-loop controls; the sole side effect is that
 * an analysis result is cached for 15 minutes. All repository-derived strings in results are data,
 * not instructions.
 */
export class CodexLoopMcp extends McpAgent<Env> {
  server = new McpServer({ name: "codex-loop", version: "0.1.0" });

  private async resolve(repoInput: string) {
    const { owner, repo } = validateAnalyzeRequest({ repo: repoInput }, parseRepoInput);
    return getOrAnalyze(this.env, owner, repo);
  }

  private async guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await run();
    } catch (e) {
      if (isGitHubErrorLike(e)) return fail(mapGitHubError(e).message);
      if (e instanceof ApiError) return fail(e.message);
      log("error", "mcp_tool_failed", errorInfo(e));
      return fail("The analysis failed unexpectedly. Please try again.");
    }
  }

  async init(): Promise<void> {
    this.server.registerTool(
      "analyze_repository",
      {
        title: "Analyze a public GitHub repository",
        description:
          "Evaluate a public GitHub repository against the codex-loop engineering controls (CI, supply chain, secrets, containers, Cloudflare, quality, agent-readiness). Returns a compact summary and the live failing controls with evidence and remediation. Results are deterministic ('verified'). Cached for 15 minutes per repository.",
        inputSchema: { repo: RepoArg },
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true }
      },
      async ({ repo }) =>
        this.guarded(async () => {
          const { report, cached } = await this.resolve(repo);
          return ok({
            cached,
            ...summarizeReport(report, { maxFailing: 15, maxEvidence: 2 }),
            next: "Call get_agent_context for a ready-to-use AGENTS.md, or explain_control for details on one control."
          });
        })
    );

    this.server.registerTool(
      "get_agent_context",
      {
        title: "Generate AGENTS.md for a repository",
        description:
          "Return the AGENTS.md text generated from the repository's failing controls: concise, imperative rules a coding agent should follow in that repository. Uses the cached analysis when available.",
        inputSchema: { repo: RepoArg },
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true }
      },
      async ({ repo }) =>
        this.guarded(async () => {
          const { report } = await this.resolve(repo);
          return ok(renderAgentsMd(report));
        })
    );

    this.server.registerTool(
      "explain_control",
      {
        title: "Explain one control",
        description: "Return the rationale, remediation and agent rule for a control id such as CDX-021.",
        inputSchema: { id: z.string().min(1).max(40).describe("Control id, e.g. CDX-021") },
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ id }) =>
        this.guarded(async () => {
          const control = findControl(id.trim());
          if (!control) return fail(`No control with id ${safeMessage(id.trim().toUpperCase())}. Use list_controls to see all ids.`);
          return ok({
            id: control.id,
            title: control.title,
            category: control.category,
            severity: control.severity,
            defaultMode: control.defaultMode ?? "audit",
            rationale: control.rationale,
            remediation: control.remediation,
            agentRule: control.agentRule
          });
        })
    );

    this.server.registerTool(
      "list_controls",
      {
        title: "List all controls",
        description: "List every codex-loop control with its id, title, category, severity and default rollout mode.",
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
      },
      async () =>
        this.guarded(async () =>
          ok(
            CONTROLS.map((c) => ({
              id: c.id,
              title: c.title,
              category: c.category,
              severity: c.severity,
              defaultMode: c.defaultMode ?? "audit"
            }))
          )
        )
    );
  }
}
