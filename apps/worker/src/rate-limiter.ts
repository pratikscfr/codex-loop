import { DurableObject } from "cloudflare:workers";
import { MAX_WINDOW_SECONDS, evaluateSlidingWindow, type WindowDecision } from "./lib/ratelimit.ts";

/**
 * Sliding-window limiter. One instance per hashed client (`ip:<hash>`) plus one `global`
 * instance. Workers' built-in rate-limit binding only supports 10s/60s periods, which cannot
 * express "20 analyses per hour", so the hit log lives in the Durable Object's SQLite.
 */
export class RateLimiter extends DurableObject<Env> {
  private ensureSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS hits (bucket TEXT NOT NULL, ts INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS hits_bucket_ts ON hits (bucket, ts)");
  }

  /**
   * Records `weight` hits when the whole request fits. Denied requests are not recorded (no penalty
   * escalation). `weight` lets one HTTP request that carries several billable operations (an MCP
   * batch) pay for each of them.
   */
  async hit(bucket: string, limit: number, windowSeconds: number, weight = 1): Promise<WindowDecision> {
    this.ensureSchema();
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const windowMs = Math.min(Math.max(1, windowSeconds), MAX_WINDOW_SECONDS) * 1000;
    const w = Math.min(Math.max(1, Math.floor(weight)), 50);

    sql.exec("DELETE FROM hits WHERE ts <= ?", now - MAX_WINDOW_SECONDS * 1000);
    const rows = sql
      .exec<{ ts: number }>("SELECT ts FROM hits WHERE bucket = ? AND ts > ?", bucket, now - windowMs)
      .toArray();
    const decision = evaluateSlidingWindow(
      now,
      rows.map((r) => r.ts),
      limit,
      windowMs,
      w
    );
    if (decision.allowed) {
      for (let i = 0; i < w; i++) sql.exec("INSERT INTO hits (bucket, ts) VALUES (?, ?)", bucket, now);
      // Garbage-collect idle limiters: once every window has lapsed the instance can be wiped.
      await this.ctx.storage.setAlarm(now + MAX_WINDOW_SECONDS * 1000 + 60_000);
    }
    return decision;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
