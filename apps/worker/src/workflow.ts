import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { analyzeGitHubRepo, type Advisory, type Report } from "@codex-loop/core";
import { generateAdvisory } from "./advisory.ts";
import { encodeWorkflowError, isGitHubErrorLike, isRetryableGitHubFailure } from "./lib/errors.ts";
import { errorInfo, log } from "./lib/log.ts";
import type { AnalyzeParams } from "./lib/types.ts";
import { fitReportForStorage, ReportTooLargeError, sanitizeReport } from "./lib/shape.ts";
import { isValidName, validateRef } from "./lib/validate.ts";
import { githubOptions, repoAgent } from "./service.ts";

interface AnalyzeStepResult {
  generatedAt: string;
  failing: number;
}

/**
 * analyze -> advisory -> persist. Step outputs are deliberately tiny (Workflows cap step results);
 * the full report is written to the repo's Durable Object from inside the analyze step.
 *
 * Failure policy:
 *  - bad_input / not_found / forbidden / empty from GitHub are permanent: NonRetryableError.
 *  - rate_limited / upstream retry with exponential backoff.
 *  - the advisory can never fail the workflow (the report is already stored).
 */
export class AnalyzeRepoWorkflow extends WorkflowEntrypoint<Env, AnalyzeParams> {
  override async run(event: WorkflowEvent<AnalyzeParams>, step: WorkflowStep): Promise<{ generatedAt: string; advisory: boolean }> {
    const { owner, repo, requestedRef, analysisId } = event.payload;
    if (!isValidName(owner) || !isValidName(repo)) {
      throw new NonRetryableError("[bad_input] Invalid repository name.");
    }
    const ref = validateRef(requestedRef);

    let meta: AnalyzeStepResult;
    try {
      meta = await step.do(
        "analyze",
        { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" }, timeout: "4 minutes" },
        async () => {
          let report: Report;
          try {
            report = await analyzeGitHubRepo(
              { owner, repo, ...(ref ? { ref } : {}), includeFootprint: true },
              githubOptions(this.env)
            );
          } catch (e) {
            if (isGitHubErrorLike(e)) {
              const message = encodeWorkflowError(e);
              const retryable = isRetryableGitHubFailure(e.kind, e.retryAfterSeconds);
              log("warn", "workflow_analyze_failed", {
                analysisId,
                repo: `${owner}/${repo}`,
                kind: e.kind,
                status: e.status,
                retryable
              });
              // Do not pass a custom name: the engine recognises the error by name === "NonRetryableError".
              if (!retryable) throw new NonRetryableError(message);
              throw new Error(message);
            }
            throw e;
          }
          const clean = sanitizeReport(report);
          // Storage failures are deterministic or at least not worth re-running the whole GitHub
          // analysis for: never let the step retry them.
          try {
            fitReportForStorage(clean);
          } catch (e) {
            if (e instanceof ReportTooLargeError) throw new NonRetryableError("[too_large] Report too large to store.");
            throw e;
          }
          const agent = await repoAgent(this.env, owner, repo);
          let saved = false;
          for (let attempt = 1; attempt <= 2 && !saved; attempt++) {
            try {
              await agent.saveReport(clean, ref, analysisId);
              saved = true;
            } catch (e) {
              log("warn", "workflow_save_failed", { analysisId, attempt, ...errorInfo(e) });
            }
          }
          if (!saved) throw new NonRetryableError("[storage] Could not store the report.");
          return {
            generatedAt: clean.generatedAt,
            failing: clean.results.filter((r) => r.status === "fail" && !r.exception).length
          };
        }
      );
    } catch (e) {
      // Let the next /api/analyze start fresh instead of waiting for the claim to go stale.
      try {
        const agent = await repoAgent(this.env, owner, repo);
        await agent.releaseAnalysis(analysisId);
      } catch (releaseError) {
        log("warn", "release_failed", errorInfo(releaseError));
      }
      throw e;
    }

    let advisory: Advisory | null = null;
    try {
      advisory = await step.do(
        "advisory",
        { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "60 seconds" },
        async () => {
          const agent = await repoAgent(this.env, owner, repo);
          // peekReport: the refresh workflow must not count as a user view.
          const report = await agent.peekReport();
          if (!report || report.generatedAt !== meta.generatedAt) return null;
          return generateAdvisory(this.env, report);
        }
      );
    } catch (e) {
      log("warn", "workflow_advisory_failed", { analysisId, ...errorInfo(e) });
    }

    let persisted = false;
    if (advisory) {
      const toSave = advisory;
      try {
        persisted = await step.do(
          "persist",
          { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" },
          async () => {
            const agent = await repoAgent(this.env, owner, repo);
            return agent.saveAdvisory(meta.generatedAt, toSave);
          }
        );
      } catch (e) {
        log("warn", "workflow_persist_failed", { analysisId, ...errorInfo(e) });
      }
    }

    log("info", "workflow_complete", { analysisId, repo: `${owner}/${repo}`, failing: meta.failing, advisory: persisted });
    return { generatedAt: meta.generatedAt, advisory: persisted };
  }
}
