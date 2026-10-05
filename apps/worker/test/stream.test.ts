import { readFileSync } from "node:fs";
import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import { INTERRUPTED_NOTICE, openTextStream, type StreamPartLike } from "../src/lib/stream.ts";
import { buildChatSystemPrompt, buildModelMessages } from "../src/lib/chat-prompt.ts";

async function* parts(...items: StreamPartLike[]): AsyncGenerator<StreamPartLike> {
  for (const i of items) yield i;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

describe("openTextStream", () => {
  it("streams text deltas, skipping tool and step parts", async () => {
    const r = await openTextStream(
      parts(
        { type: "start" },
        { type: "tool-call" },
        { type: "tool-result" },
        { type: "text-delta", text: "Hel" },
        { type: "finish-step" },
        { type: "text-delta", text: "lo" },
        { type: "finish" }
      )
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [body, done] = await Promise.all([readAll(r.stream), r.done]);
    expect(body).toBe("Hello");
    expect(done.text).toBe("Hello");
    expect(done.error).toBeUndefined();
  });

  it("reports a model error that happens before any text (so the caller can return 503)", async () => {
    const r = await openTextStream(parts({ type: "start" }, { type: "error", error: new Error("AI binding failed") }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("error");
    expect(String(r.error)).toMatch(/AI binding failed/);
  });

  it("reports thrown iterator errors and aborts the same way", async () => {
    async function* throwing(): AsyncGenerator<StreamPartLike> {
      yield { type: "start" };
      throw new Error("network down");
    }
    const t = await openTextStream(throwing());
    expect(t.ok).toBe(false);
    const a = await openTextStream(parts({ type: "abort" }));
    expect(a.ok).toBe(false);
  });

  it("reports an empty answer distinctly", async () => {
    const r = await openTextStream(parts({ type: "start" }, { type: "finish" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("empty");
  });

  it("appends a notice and surfaces the error when the model fails mid-stream", async () => {
    const r = await openTextStream(
      parts({ type: "text-delta", text: "partial" }, { type: "error", error: new Error("cut off") })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [body, done] = await Promise.all([readAll(r.stream), r.done]);
    expect(body).toBe(`partial${INTERRUPTED_NOTICE}`);
    expect(String(done.error)).toMatch(/cut off/);
    expect(done.text).toBe("partial");
  });

  it("keeps consuming the model (and resolves done) when the client cancels early", async () => {
    let finished = false;
    async function* slow(): AsyncGenerator<StreamPartLike> {
      yield { type: "text-delta", text: "a" };
      yield { type: "text-delta", text: "b" };
      yield { type: "text-delta", text: "c" };
      finished = true;
    }
    const r = await openTextStream(slow());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reader = r.stream.getReader();
    await reader.read();
    await reader.cancel();
    const done = await r.done;
    expect(finished).toBe(true);
    expect(done.text).toBe("abc");
  });
});

describe("openTextStream: incomplete answers are never reported as finished", () => {
  it("an abort AFTER the first token is an error, not a complete answer", async () => {
    const r = await openTextStream(parts({ type: "text-delta", text: "half an ans" }, { type: "abort" }, { type: "text-delta", text: "ignored" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [body, done] = await Promise.all([readAll(r.stream), r.done]);
    expect(body).toBe(`half an ans${INTERRUPTED_NOTICE}`);
    expect(done.finished).toBe(false);
    expect(String(done.error)).toMatch(/aborted/);
    expect(done.text).toBe("half an ans");
  });

  it("only a normal finish part marks the answer complete", async () => {
    const ok = await openTextStream(parts({ type: "text-delta", text: "done" }, { type: "finish" }));
    if (!ok.ok) throw new Error("expected ok");
    await readAll(ok.stream);
    expect((await ok.done).finished).toBe(true);

    const silent = await openTextStream(parts({ type: "text-delta", text: "cut" }));
    if (!silent.ok) throw new Error("expected ok");
    await readAll(silent.stream);
    const done = await silent.done;
    expect(done.finished).toBe(false);
    expect(done.error).toBeUndefined();
  });

  it("a mid-stream error is unfinished even if a finish part follows", async () => {
    const r = await openTextStream(parts({ type: "text-delta", text: "a" }, { type: "error", error: new Error("x") }, { type: "finish" }));
    if (!r.ok) throw new Error("expected ok");
    await readAll(r.stream);
    expect((await r.done).finished).toBe(false);
  });
});

describe("chat persistence is skipped for incomplete answers", () => {
  it("chat.ts stores the exchange only when the model finished normally", () => {
    const src = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
    expect(src).toMatch(/if \(error !== undefined \|\| !finished\)/);
    expect(src.indexOf("!finished") < src.indexOf("appendChat(")).toBe(true);
  });
});

describe("chat prompt", () => {
  it("mentions the repo, grounding rules and the untrusted-data warning", () => {
    const p = buildChatSystemPrompt("acme", "widgets");
    expect(p).toMatch(/acme\/widgets/);
    expect(p).toMatch(/I don't know/);
    expect(p).toMatch(/verified/);
    expect(p).toMatch(/suggestion/);
    expect(p).toMatch(/untrusted/);
  });

  it("builds an alternating, bounded conversation ending in the new user turn", () => {
    const t = (role: "user" | "assistant", content: string) => ({ role, content, createdAt: 1 });
    const msgs = buildModelMessages(
      [t("assistant", "stray"), t("user", "q1"), t("assistant", "a1"), t("user", "q2-unanswered")],
      "q3"
    );
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "q3" });
    expect(msgs[0]?.content).toBe("q1");
  });

  it("drops the oldest turns when the history is too large", () => {
    const t = (role: "user" | "assistant", i: number) => ({ role, content: `${i}:` + "x".repeat(1900), createdAt: i });
    const history = Array.from({ length: 30 }, (_, i) => t(i % 2 === 0 ? "user" : "assistant", i));
    const msgs = buildModelMessages(history, "now");
    const total = msgs.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(12_000 + 10);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[msgs.length - 1]?.content).toBe("now");
    expect(msgs.length < 31).toBe(true);
  });
});
