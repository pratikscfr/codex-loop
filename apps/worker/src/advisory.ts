import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";
import type { Advisory, Report } from "@codex-loop/core";
import { buildAdvisoryPrompt } from "./lib/advisory-prompt.ts";
import { buildAdvisory, extractJsonObject } from "./lib/citations.ts";
import { errorInfo, log } from "./lib/log.ts";
import { modelId } from "./service.ts";

/**
 * Optional LLM layer. It can only ever *add* a clearly-labelled advisory: every failure mode
 * (no binding, model error, timeout, bad JSON, uncitable output) collapses to `null` and the
 * deterministic report is untouched. The model gets no tools, and the output is citation-checked
 * against the report by `buildAdvisory`.
 */
export async function generateAdvisory(env: Env, report: Report, now: Date = new Date()): Promise<Advisory | null> {
  try {
    const built = buildAdvisoryPrompt(report);
    if (!built) return null;
    const id = modelId(env);
    const workersai = createWorkersAI({ binding: env.AI });
    const { text } = await generateText({
      model: workersai(id),
      system: built.system,
      prompt: built.prompt,
      temperature: 0.2,
      maxOutputTokens: 800,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(40_000)
    });
    const advisory = buildAdvisory(extractJsonObject(text), report, { generatedBy: id, generatedAt: now.toISOString() });
    log("info", "advisory_generated", { model: id, kept: advisory?.priorities.length ?? 0 });
    return advisory;
  } catch (e) {
    log("warn", "advisory_skipped", errorInfo(e));
    return null;
  }
}
