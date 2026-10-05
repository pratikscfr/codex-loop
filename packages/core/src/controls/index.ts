import type { Control } from "../types.ts";
import { ACTIONS_PINNED, CI_CONFIGURED, WORKFLOW_PERMISSIONS } from "./ci.ts";
import { DOCKER_BASE_PINNED, DOCKER_NON_ROOT } from "./containers.ts";
import { WRANGLER_COMPAT_DATE, WRANGLER_NO_SECRET_VARS, WRANGLER_OBSERVABILITY } from "./cloudflare.ts";
import { AGENT_CONTEXT_FILE, CODEOWNERS, LICENSE, README, SECURITY_POLICY } from "./hygiene.ts";
import { TESTS_EXIST, TS_STRICT } from "./quality.ts";
import { COMMITTED_SECRET_FILES, GITIGNORE_ENV, SECRET_SCAN } from "./secrets.ts";
import { DEPENDENCY_UPDATES, LOCKFILES } from "./supply-chain.ts";

/**
 * The standards catalog. Order matters: cheap structural controls run first so the (budgeted)
 * content scan in CDX-032 gets whatever file-read budget is left.
 */
export const CONTROLS: Control[] = [
  README,
  CODEOWNERS,
  SECURITY_POLICY,
  LICENSE,
  CI_CONFIGURED,
  ACTIONS_PINNED,
  WORKFLOW_PERMISSIONS,
  LOCKFILES,
  DEPENDENCY_UPDATES,
  DOCKER_BASE_PINNED,
  DOCKER_NON_ROOT,
  WRANGLER_COMPAT_DATE,
  WRANGLER_OBSERVABILITY,
  WRANGLER_NO_SECRET_VARS,
  TS_STRICT,
  TESTS_EXIST,
  AGENT_CONTEXT_FILE,
  GITIGNORE_ENV,
  COMMITTED_SECRET_FILES,
  SECRET_SCAN
];

export const CONTROL_IDS: ReadonlySet<string> = new Set(CONTROLS.map((c) => c.id));

export function findControl(id: string): Control | undefined {
  const wanted = id.trim().toUpperCase();
  return CONTROLS.find((c) => c.id === wanted);
}
