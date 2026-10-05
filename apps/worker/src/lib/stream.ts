/**
 * Turns an AI SDK `fullStream` into a plain-text HTTP stream *after* confirming the model actually
 * produced something. If the model/binding fails before the first token we can still answer with a
 * clean 503 JSON instead of a 200 that silently streams nothing.
 */

export interface StreamPartLike {
  type: string;
  text?: string;
  error?: unknown;
}

export type OpenTextStream =
  | { ok: false; reason: "error" | "empty"; error?: unknown }
  | {
      ok: true;
      stream: ReadableStream<Uint8Array>;
      /**
       * Resolves once the model finished (even if the client disconnected early). Never rejects.
       * `finished` is true only when the model signalled a normal finish; aborts, errors and a stream
       * that just ends are all incomplete and must not be stored as a finished answer.
       */
      done: Promise<{ text: string; error?: unknown; finished: boolean }>;
    };

export const INTERRUPTED_NOTICE = "\n\n[The answer was interrupted. Please try again.]";

export async function openTextStream(parts: AsyncIterable<StreamPartLike>): Promise<OpenTextStream> {
  const iterator = parts[Symbol.asyncIterator]();
  let first: string | null = null;

  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.type === "error") return { ok: false, reason: "error", error: value.error };
      if (value.type === "abort") return { ok: false, reason: "error", error: new Error("aborted") };
      if (value.type === "text-delta" && value.text) {
        first = value.text;
        break;
      }
    }
  } catch (error) {
    return { ok: false, reason: "error", error };
  }
  if (first === null) return { ok: false, reason: "empty" };
  const firstText: string = first;

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let clientGone = false;
  const write = async (s: string) => {
    if (clientGone) return;
    try {
      await writer.write(encoder.encode(s));
    } catch {
      clientGone = true;
    }
  };

  const done = (async () => {
    let text = firstText;
    let error: unknown;
    let finished = false;
    await write(firstText);
    try {
      for (;;) {
        const { value, done: ended } = await iterator.next();
        if (ended) break;
        if (value.type === "text-delta" && value.text) {
          text += value.text;
          await write(value.text);
        } else if (value.type === "error") {
          error = value.error;
          break;
        } else if (value.type === "abort") {
          error = new Error("aborted");
          break;
        } else if (value.type === "finish") {
          finished = true;
        }
      }
    } catch (e) {
      error = e;
    }
    if (error !== undefined) await write(INTERRUPTED_NOTICE);
    try {
      await writer.close();
    } catch {
      /* client already gone */
    }
    return { text, error, finished: finished && error === undefined };
  })();

  return { ok: true, stream: readable, done };
}
