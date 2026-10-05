/**
 * Policy for the daily background re-analysis. The window is measured from the last *user* view
 * (web report / chat / AGENTS.md, or an MCP tool call) and is never renewed by the refresh itself,
 * so a repository nobody looks at stops refreshing after a week.
 */

export const VIEW_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** User views are recorded at most this often (keeps reads from turning into writes). */
export const VIEW_TOUCH_INTERVAL_MS = 60 * 60_000;

/** True while a refresh is still allowed. `lastUserViewMs` of 0/NaN means "never viewed". */
export function refreshAllowed(nowMs: number, lastUserViewMs: number, windowMs: number = VIEW_WINDOW_MS): boolean {
  if (!Number.isFinite(lastUserViewMs) || lastUserViewMs <= 0) return false;
  return nowMs - lastUserViewMs <= windowMs;
}

export function shouldRecordView(nowMs: number, lastRecordedMs: number, intervalMs: number = VIEW_TOUCH_INTERVAL_MS): boolean {
  return !Number.isFinite(lastRecordedMs) || nowMs - lastRecordedMs >= intervalMs;
}
