export * from "./types.ts";

export { analyze, failingCount, ENGINE_VERSION } from "./engine.ts";
export type { AnalyzeOptions, FailOn } from "./engine.ts";

export { CONTROLS, CONTROL_IDS, findControl } from "./controls/index.ts";

export { DEFAULT_CONFIG, CONFIG_FILES, loadConfig, normalizeConfig, MAX_EXCEPTION_DAYS } from "./config.ts";
export type { LoadedConfig } from "./config.ts";

export { profileRepo } from "./profile.ts";

export { createLazySnapshot, createMemorySnapshot, ReadBudgetExceeded } from "./snapshot.ts";
export type { BudgetedSnapshot, LazySnapshotInit } from "./snapshot.ts";

export { renderAgentsMd, renderManagedBlock, upsertManagedBlock, BLOCK_BEGIN, BLOCK_END, DEFAULT_MAX_CHARS } from "./agents-md.ts";
export type { AgentsMdOptions } from "./agents-md.ts";

export { renderMarkdown, renderText, githubAnnotations, COMMENT_MARKER, mdText, mdCode } from "./format.ts";
export type { MarkdownOptions } from "./format.ts";

export { classifyPullRequest, summarizeFootprint, MIN_SAMPLE, FOOTPRINT_CAVEAT } from "./footprint.ts";
export type { PullRequestInput } from "./footprint.ts";

export { analyzeGitHubRepo, parseRepoInput, GitHubError, DEFAULT_MAX_FILE_READS } from "./github.ts";
export type { GitHubOptions, GitHubErrorKind } from "./github.ts";
