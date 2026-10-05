import { Agent } from "agents";
import type { Advisory, Report } from "@codex-loop/core";
import { CHAT_MESSAGES_PER_SESSION, CHAT_SESSIONS_PER_REPO, messageTrimBoundary, sessionsToEvict } from "./lib/chat-sessions.ts";
import { errorInfo, log } from "./lib/log.ts";
import { GLOBAL_RULES } from "./lib/ratelimit.ts";
import { VIEW_WINDOW_MS, refreshAllowed, shouldRecordView } from "./lib/refresh.ts";
import { fitReportForStorage, historyEntry, isFresh, sanitizeReport } from "./lib/shape.ts";
import type { AnalyzeParams, ChatMessage, ClaimResult, HistoryEntry } from "./lib/types.ts";

/** Small, broadcast-safe summary of what this agent holds (the full report lives in SQL). */
export interface RepoState {
  repo: string;
  generatedAt: string | null;
  pass: number;
  fail: number;
  unknown: number;
  blocking: number;
}

export interface ReportBundle {
  report: Report;
  history: HistoryEntry[];
  requestedRef: string;
}

const HISTORY_RETAINED = 200;
export const HISTORY_RETURNED = 20;
const MAX_CHAT_CHARS = 8000;
/** An unfinished claim older than this is assumed dead (workflow crashed / was terminated). */
const INFLIGHT_STALE_MS = 5 * 60_000;
const REFRESH_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * One Durable Object per lowercase "owner/repo". Everything is reached via stub RPC.
 *
 * `last_viewed_at` is what keeps the daily refresh alive, so it is written ONLY by methods that
 * serve a user request (`getBundle`, `getReport`, `getFreshReport(..., touch)`, `claimAnalysis(...,
 * touch)`, `getChat`). `saveReport`, `peekReport` and the refresh path never renew it.
 */
export class RepoAgent extends Agent<Env, RepoState> {
  override initialState: RepoState = { repo: "", generatedAt: null, pass: 0, fail: 0, unknown: 0, blocking: 0 };

  private schemaReady = false;

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS cl_report (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      requested_ref TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      stored_at INTEGER NOT NULL,
      json TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS cl_history (
      generated_at TEXT PRIMARY KEY,
      pass INTEGER NOT NULL,
      fail INTEGER NOT NULL,
      unknown INTEGER NOT NULL,
      blocking INTEGER NOT NULL
    )`;
    // Chat history is scoped per browser session. The legacy shared table is dropped.
    this.sql`DROP TABLE IF EXISTS cl_chat`;
    this.sql`CREATE TABLE IF NOT EXISTS cl_chat_s (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS cl_chat_s_session ON cl_chat_s (session_id, id)`;
    this.sql`CREATE TABLE IF NOT EXISTS cl_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
    this.schemaReady = true;
  }

  private getMeta(key: string): string | null {
    return this.sql<{ v: string }>`SELECT v FROM cl_meta WHERE k = ${key}`[0]?.v ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql`INSERT INTO cl_meta (k, v) VALUES (${key}, ${value})
      ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
  }

  private deleteMeta(key: string): void {
    this.sql`DELETE FROM cl_meta WHERE k = ${key}`;
  }

  private readRow(): { requested_ref: string; generated_at: string; json: string } | null {
    return (
      this.sql<{ requested_ref: string; generated_at: string; json: string }>`
        SELECT requested_ref, generated_at, json FROM cl_report WHERE id = 1`[0] ?? null
    );
  }

  private parseRow(row: { json: string }): Report | null {
    try {
      return JSON.parse(row.json) as Report;
    } catch {
      return null;
    }
  }

  private readHistory(limit: number): HistoryEntry[] {
    const rows = this.sql<HistoryEntry>`
      SELECT generated_at AS generatedAt, pass, fail, unknown, blocking
      FROM cl_history ORDER BY generated_at DESC LIMIT ${limit}`;
    return rows.reverse().map((r) => ({
      generatedAt: String(r.generatedAt),
      pass: Number(r.pass),
      fail: Number(r.fail),
      unknown: Number(r.unknown),
      blocking: Number(r.blocking)
    }));
  }

  /** Record that a USER looked at this repo (gates the daily refresh). Throttled. Never call from refresh paths. */
  private recordUserView(now: number): void {
    if (shouldRecordView(now, Number(this.getMeta("last_viewed_at") ?? 0))) this.setMeta("last_viewed_at", String(now));
  }

  // ---- analysis lifecycle -------------------------------------------------------------------

  /** Report younger than `ttlMs` for the same requested ref, else null. `touch` = a user asked. */
  async getFreshReport(ttlMs: number, requestedRef: string, touch = false): Promise<Report | null> {
    this.ensureSchema();
    const now = Date.now();
    if (touch) this.recordUserView(now);
    const row = this.readRow();
    if (!row || row.requested_ref !== requestedRef || !isFresh(row.generated_at, now, ttlMs)) return null;
    return this.parseRow(row);
  }

  /**
   * Atomically decide what a new analyze request should do: serve the cache, join the analysis
   * that is already running, or claim the right to start a new one with `id`.
   */
  async claimAnalysis(id: string, requestedRef: string, ttlMs: number, touch = false): Promise<ClaimResult<Report>> {
    this.ensureSchema();
    const now = Date.now();
    if (touch) this.recordUserView(now);
    const row = this.readRow();
    if (row && row.requested_ref === requestedRef && isFresh(row.generated_at, now, ttlMs)) {
      const report = this.parseRow(row);
      if (report) return { kind: "cached", report };
    }
    const inflightId = this.getMeta("inflight_id");
    const inflightAt = Number(this.getMeta("inflight_at") ?? 0);
    const inflightRef = this.getMeta("inflight_ref") ?? "";
    if (inflightId && inflightRef === requestedRef && now - inflightAt < INFLIGHT_STALE_MS) {
      return { kind: "inflight", id: inflightId };
    }
    this.setMeta("inflight_id", id);
    this.setMeta("inflight_at", String(now));
    this.setMeta("inflight_ref", requestedRef);
    return { kind: "claimed" };
  }

  async releaseAnalysis(id: string): Promise<void> {
    this.ensureSchema();
    if (this.getMeta("inflight_id") === id) {
      this.deleteMeta("inflight_id");
      this.deleteMeta("inflight_at");
      this.deleteMeta("inflight_ref");
    }
  }

  // ---- report storage -----------------------------------------------------------------------

  /** Stores the (sanitised) report. Does NOT count as a user view: a refresh must not renew itself. */
  async saveReport(report: Report, requestedRef: string, analysisId?: string): Promise<void> {
    this.ensureSchema();
    const clean = sanitizeReport(report);
    const now = Date.now();
    const json = fitReportForStorage(clean);
    this.sql`INSERT INTO cl_report (id, requested_ref, generated_at, stored_at, json)
      VALUES (1, ${requestedRef}, ${clean.generatedAt}, ${now}, ${json})
      ON CONFLICT(id) DO UPDATE SET requested_ref = excluded.requested_ref,
        generated_at = excluded.generated_at, stored_at = excluded.stored_at, json = excluded.json`;

    const h = historyEntry(clean);
    this.sql`INSERT OR REPLACE INTO cl_history (generated_at, pass, fail, unknown, blocking)
      VALUES (${h.generatedAt}, ${h.pass}, ${h.fail}, ${h.unknown}, ${h.blocking})`;
    this.sql`DELETE FROM cl_history WHERE generated_at NOT IN
      (SELECT generated_at FROM cl_history ORDER BY generated_at DESC LIMIT ${HISTORY_RETAINED})`;

    const repoName = clean.repo ? `${clean.repo.owner}/${clean.repo.repo}` : "";
    if (clean.repo) {
      this.setMeta("owner", clean.repo.owner);
      this.setMeta("repo", clean.repo.repo);
    }
    if (analysisId) await this.releaseAnalysis(analysisId);

    this.setState({
      repo: repoName,
      generatedAt: clean.generatedAt,
      pass: h.pass,
      fail: h.fail,
      unknown: h.unknown,
      blocking: h.blocking
    });

    try {
      // Idempotent: at most one daily refresh schedule per repo.
      await this.scheduleEvery(REFRESH_INTERVAL_SECONDS, "scheduledRefresh");
    } catch (e) {
      log("warn", "schedule_failed", errorInfo(e));
    }
  }

  /** Attach the (already validated) advisory to the report it was generated for. */
  async saveAdvisory(generatedAt: string, advisory: Advisory | null): Promise<boolean> {
    this.ensureSchema();
    if (!advisory) return false;
    const row = this.readRow();
    if (!row || row.generated_at !== generatedAt) return false;
    const report = this.parseRow(row);
    if (!report) return false;
    report.advisory = advisory;
    const json = fitReportForStorage(report);
    this.sql`UPDATE cl_report SET json = ${json} WHERE id = 1`;
    return true;
  }

  /** Internal read for the workflow / refresh path: never counts as a user view. */
  async peekReport(): Promise<Report | null> {
    this.ensureSchema();
    const row = this.readRow();
    return row ? this.parseRow(row) : null;
  }

  /** User-facing read (AGENTS.md, chat): counts as a view. */
  async getReport(): Promise<Report | null> {
    this.ensureSchema();
    const row = this.readRow();
    if (!row) return null;
    this.recordUserView(Date.now());
    return this.parseRow(row);
  }

  async getBundle(): Promise<ReportBundle | null> {
    this.ensureSchema();
    const row = this.readRow();
    if (!row) return null;
    const report = this.parseRow(row);
    if (!report) return null;
    this.recordUserView(Date.now());
    return { report, history: this.readHistory(HISTORY_RETURNED), requestedRef: row.requested_ref };
  }

  async getHistory(limit: number = HISTORY_RETURNED): Promise<HistoryEntry[]> {
    this.ensureSchema();
    return this.readHistory(Math.min(Math.max(1, Math.floor(limit)), HISTORY_RETAINED));
  }

  // ---- chat memory (per browser session) ----------------------------------------------------

  /** Only the caller's own session is ever returned, and only that session is replayed to the model. */
  async getChat(sessionId: string, limit: number = CHAT_MESSAGES_PER_SESSION): Promise<ChatMessage[]> {
    this.ensureSchema();
    this.recordUserView(Date.now());
    const n = Math.min(Math.max(1, Math.floor(limit)), CHAT_MESSAGES_PER_SESSION);
    const rows = this.sql<{ role: string; content: string; created_at: number }>`
      SELECT role, content, created_at FROM cl_chat_s WHERE session_id = ${sessionId}
      ORDER BY id DESC LIMIT ${n}`;
    return rows.reverse().map((r) => ({
      role: r.role === "assistant" ? "assistant" : "user",
      content: String(r.content),
      createdAt: Number(r.created_at)
    }));
  }

  async appendChat(sessionId: string, messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = String(m.content).slice(0, MAX_CHAT_CHARS);
      this.sql`INSERT INTO cl_chat_s (session_id, role, content, created_at) VALUES (${sessionId}, ${role}, ${content}, ${now})`;
    }
    // Keep the newest N messages of this session...
    const ids = this.sql<{ id: number }>`SELECT id FROM cl_chat_s WHERE session_id = ${sessionId} ORDER BY id`.map((r) => Number(r.id));
    const boundary = messageTrimBoundary(ids, CHAT_MESSAGES_PER_SESSION);
    if (boundary !== null) this.sql`DELETE FROM cl_chat_s WHERE session_id = ${sessionId} AND id <= ${boundary}`;
    // ...and the most recently active sessions of this repo.
    const sessions = this.sql<{ session_id: string; last_id: number }>`
      SELECT session_id, MAX(id) AS last_id FROM cl_chat_s GROUP BY session_id`;
    for (const victim of sessionsToEvict(
      sessions.map((s) => ({ sessionId: String(s.session_id), lastId: Number(s.last_id) })),
      CHAT_SESSIONS_PER_REPO
    )) {
      this.sql`DELETE FROM cl_chat_s WHERE session_id = ${victim}`;
    }
  }

  // ---- daily refresh ------------------------------------------------------------------------

  /**
   * Scheduled (daily) re-analysis. Only runs while a USER viewed the repo within the last 7 days;
   * the refresh never renews that window, so an unviewed repo cancels its own schedule.
   */
  async scheduledRefresh(): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    const lastViewed = Number(this.getMeta("last_viewed_at") ?? 0);
    if (!refreshAllowed(now, lastViewed, VIEW_WINDOW_MS)) {
      for (const s of this.getSchedules()) {
        if (s.callback === "scheduledRefresh") await this.cancelSchedule(s.id);
      }
      return;
    }
    const owner = this.getMeta("owner");
    const repo = this.getMeta("repo");
    if (!owner || !repo) return;
    const requestedRef = this.readRow()?.requested_ref ?? "";

    const id = crypto.randomUUID();
    // Skip when an analysis happened within the last 12 hours. touch=false: not a user view.
    const claim = await this.claimAnalysis(id, requestedRef, 12 * 60 * 60_000, false);
    if (claim.kind !== "claimed") return;

    try {
      const limiter = this.env.RATE_LIMITER.get(this.env.RATE_LIMITER.idFromName("global"));
      const decision = await limiter.hit(
        GLOBAL_RULES.analyze.bucket,
        GLOBAL_RULES.analyze.limit,
        GLOBAL_RULES.analyze.windowSeconds
      );
      if (!decision.allowed) {
        await this.releaseAnalysis(id);
        return;
      }
      const params: AnalyzeParams = { owner, repo, requestedRef, analysisId: id };
      await this.env.ANALYZE_WORKFLOW.create({ id, params });
      log("info", "scheduled_refresh_started", { repo: `${owner}/${repo}`, analysisId: id });
    } catch (e) {
      await this.releaseAnalysis(id);
      log("warn", "scheduled_refresh_failed", { repo: `${owner}/${repo}`, ...errorInfo(e) });
    }
  }
}
