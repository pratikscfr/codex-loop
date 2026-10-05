/**
 * Retention policy for per-session chat history stored in a repo's Durable Object. The SQL lives in
 * repo-agent.ts; the decisions (what to evict) live here so they can be tested.
 */

export const CHAT_MESSAGES_PER_SESSION = 30;
export const CHAT_SESSIONS_PER_REPO = 20;

/**
 * Given the row ids of one session's messages, return the highest id that must be deleted so that
 * only the newest `keep` remain (ids ascend with time), or null when nothing needs to go.
 */
export function messageTrimBoundary(ids: readonly number[], keep: number = CHAT_MESSAGES_PER_SESSION): number | null {
  if (ids.length <= keep) return null;
  const sorted = [...ids].sort((a, b) => a - b);
  return sorted[sorted.length - keep - 1] ?? null;
}

/** Sessions to drop so that only the `keep` most recently active (by newest message id) remain. */
export function sessionsToEvict(
  sessions: ReadonlyArray<{ sessionId: string; lastId: number }>,
  keep: number = CHAT_SESSIONS_PER_REPO
): string[] {
  if (sessions.length <= keep) return [];
  return [...sessions]
    .sort((a, b) => b.lastId - a.lastId)
    .slice(keep)
    .map((s) => s.sessionId);
}
