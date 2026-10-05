import { readFileSync } from "node:fs";
import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import {
  CHAT_MESSAGES_PER_SESSION,
  CHAT_SESSIONS_PER_REPO,
  messageTrimBoundary,
  sessionsToEvict
} from "../src/lib/chat-sessions.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("per-session chat retention", () => {
  it("keeps 30 messages per session and 20 sessions per repo", () => {
    expect(CHAT_MESSAGES_PER_SESSION).toBe(30);
    expect(CHAT_SESSIONS_PER_REPO).toBe(20);
  });

  it("messageTrimBoundary deletes only the oldest messages beyond the cap", () => {
    expect(messageTrimBoundary([1, 2, 3], 30)).toBeNull();
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(messageTrimBoundary(ids, 30)).toBeNull();
    const plus2 = Array.from({ length: 32 }, (_, i) => 100 + i * 3);
    const boundary = messageTrimBoundary(plus2, 30);
    expect(boundary).toBe(103); // the two oldest (100, 103) go; 30 remain
    expect(plus2.filter((id) => id > (boundary as number))).toHaveLength(30);
    // order of input does not matter
    expect(messageTrimBoundary([...plus2].reverse(), 30)).toBe(103);
  });

  it("sessionsToEvict keeps the 20 most recently active sessions and drops the rest", () => {
    const sessions = Array.from({ length: 23 }, (_, i) => ({ sessionId: `s${i}`, lastId: i * 10 }));
    const victims = sessionsToEvict(sessions, 20);
    expect(victims.sort()).toEqual(["s0", "s1", "s2"]); // the three least recent
    expect(sessionsToEvict(sessions.slice(0, 20), 20)).toEqual([]);
    // a session that just spoke survives even if it was created first
    const bumped = sessions.map((s) => (s.sessionId === "s0" ? { ...s, lastId: 9999 } : s));
    expect(sessionsToEvict(bumped, 20).includes("s0")).toBe(false);
    expect(sessionsToEvict(bumped, 20)).toHaveLength(3);
  });
});

describe("chat isolation between visitors (source guards for the Durable Object + route wiring)", () => {
  const agent = read("../src/repo-agent.ts");

  it("every chat query is filtered by session_id and no shared table remains", () => {
    const getChat = agent.slice(agent.indexOf("async getChat("), agent.indexOf("async appendChat("));
    expect(getChat).toMatch(/WHERE session_id = \$\{sessionId\}/);
    const append = agent.slice(agent.indexOf("async appendChat("), agent.indexOf("// ---- daily refresh"));
    expect(append).toMatch(/INSERT INTO cl_chat_s \(session_id,/);
    expect(append).toMatch(/DELETE FROM cl_chat_s WHERE session_id = \$\{sessionId\} AND id <=/);
    expect(agent).toMatch(/DROP TABLE IF EXISTS cl_chat`/);
    expect(/FROM cl_chat\b(?!_s)/.test(agent)).toBe(false);
  });

  it("routes require the session header and only replay that session to the model", () => {
    const routes = read("../src/routes.ts");
    const chatHistory = routes.slice(routes.indexOf("async function chatHistory("), routes.indexOf("async function chat("));
    const chat = routes.slice(routes.indexOf("async function chat("));
    for (const fn of [chatHistory, chat]) {
      expect(fn).toMatch(/validateSessionId\(rc\.request\.headers\.get\("x-session-id"\)\)/);
      expect(fn).toMatch(/agent\.getChat\(sessionId\)/);
    }
    expect(read("../src/chat.ts")).toMatch(/appendChat\(c\.sessionId,/);
  });
});
