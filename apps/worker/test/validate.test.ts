import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import { ApiError } from "../src/lib/errors.ts";
import {
  checkSameOrigin,
  isValidAnalysisId,
  isValidName,
  parseRepoParams,
  readLimitedText,
  repoKey,
  requireJsonContentType,
  validateAnalyzeRequest,
  validateChatRequest,
  validateControlId,
  validateRef,
  validateSessionId,
  REF_UNSUPPORTED_MESSAGE,
  parseJsonObject
} from "../src/lib/validate.ts";

/** Minimal stand-in for core's parseRepoInput so these tests do not depend on it. */
function parse(input: string): { owner: string; repo: string } | null {
  const m = /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/.exec(input);
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected ApiError");
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    }
  });
}

describe("repo names", () => {
  it("accepts GitHub-shaped names and rejects everything else", () => {
    for (const ok of ["a", "cloudflare", "agents-starter", "my_repo.js", "A-b_c.1"]) expect(isValidName(ok)).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a b", "a;b", "a\nb", "x".repeat(101), "é", "a%2Fb"]) {
      expect(isValidName(bad)).toBe(false);
    }
  });

  it("parseRepoParams returns coordinates or a 400", () => {
    expect(parseRepoParams("cloudflare", "agents")).toEqual({ owner: "cloudflare", repo: "agents" });
    const err = errorOf(() => parseRepoParams("cloudflare", ".."));
    expect(err.status).toBe(400);
    expect(err.code).toBe("bad_input");
    expect(errorOf(() => parseRepoParams(undefined, "x")).status).toBe(400);
  });

  it("repoKey is the lowercase durable object name", () => {
    expect(repoKey("Cloudflare", "Agents-Starter")).toBe("cloudflare/agents-starter");
  });
});

describe("validateAnalyzeRequest", () => {
  it("accepts owner/repo and URLs through the injected parser and re-validates strictly", () => {
    expect(validateAnalyzeRequest({ repo: "cloudflare/agents" }, parse)).toEqual({ owner: "cloudflare", repo: "agents" });
    expect(validateAnalyzeRequest({ repo: "https://github.com/a/b.git" }, parse)).toEqual({ owner: "a", repo: "b" });
  });

  it("rejects a caller-chosen ref: the hosted service only analyzes the default branch", () => {
    for (const ref of ["main", "", "abc123", "../x", 5, {}]) {
      const err = errorOf(() => validateAnalyzeRequest({ repo: "a/b", ref }, parse));
      expect(err.status).toBe(400);
      expect(err.code).toBe("bad_input");
      expect(err.message).toBe(REF_UNSUPPORTED_MESSAGE);
    }
    expect(REF_UNSUPPORTED_MESSAGE).toMatch(/codex-loop remote owner\/repo --ref/);
    // null / undefined are "no ref" and stay accepted
    expect(validateAnalyzeRequest({ repo: "a/b", ref: null }, parse)).toEqual({ owner: "a", repo: "b" });
  });

  it("rejects non-objects, missing or oversized input, unparsable input and bad names", () => {
    for (const body of [null, "x", [], 42, {}, { repo: 5 }, { repo: "   " }]) {
      expect(errorOf(() => validateAnalyzeRequest(body, parse)).status).toBe(400);
    }
    expect(errorOf(() => validateAnalyzeRequest({ repo: "a/".repeat(200) }, parse)).status).toBe(400);
    expect(errorOf(() => validateAnalyzeRequest({ repo: "nonsense" }, parse)).code).toBe("bad_input");
    // Parser says yes but the strict regex still says no.
    const evil = () => ({ owner: "a;rm -rf", repo: "b" });
    expect(errorOf(() => validateAnalyzeRequest({ repo: "x/y" }, evil)).code).toBe("bad_input");
    // A throwing parser is treated as unparsable, not as a 500.
    const throwing = () => {
      throw new Error("boom");
    };
    expect(errorOf(() => validateAnalyzeRequest({ repo: "x/y" }, throwing)).status).toBe(400);
  });
});

describe("validateSessionId", () => {
  it("accepts a UUID (any case, normalised to lower case)", () => {
    expect(validateSessionId("3F2B8C1E-5D47-4A0B-9C3E-0123456789AB")).toBe("3f2b8c1e-5d47-4a0b-9c3e-0123456789ab");
    expect(validateSessionId("  3f2b8c1e-5d47-4a0b-9c3e-0123456789ab ")).toBe("3f2b8c1e-5d47-4a0b-9c3e-0123456789ab");
  });

  it("rejects a missing or malformed header with a 400", () => {
    for (const bad of [null, "", "not-a-uuid", "3f2b8c1e5d474a0b9c3e0123456789ab", "../../etc/passwd", "3f2b8c1e-5d47-4a0b-9c3e-0123456789ab-extra", "x".repeat(200)]) {
      const err = errorOf(() => validateSessionId(bad));
      expect(err.status).toBe(400);
      expect(err.code).toBe("bad_request");
    }
  });
});

describe("validateRef", () => {
  it("allows plain refs and SHAs, empty means default branch", () => {
    expect(validateRef(undefined)).toBe("");
    expect(validateRef("")).toBe("");
    expect(validateRef("  ")).toBe("");
    expect(validateRef("main")).toBe("main");
    expect(validateRef("feature/x-1.2")).toBe("feature/x-1.2");
    expect(validateRef("a".repeat(40))).toBe("a".repeat(40));
  });

  it("rejects traversal, flags, whitespace and non-strings", () => {
    for (const bad of ["../x", "a..b", "-rf", "a b", "a//b", "a/", "a.lock", "a/.hidden", "x".repeat(201), "a;b", 5, {}]) {
      expect(errorOf(() => validateRef(bad)).code).toBe("bad_input");
    }
  });
});

describe("validateChatRequest", () => {
  it("trims, strips control chars and bounds the length", () => {
    expect(validateChatRequest({ message: "  hi\u0000 there  " })).toEqual({ message: "hi there" });
    expect(errorOf(() => validateChatRequest({ message: "" })).status).toBe(400);
    expect(errorOf(() => validateChatRequest({ message: 5 })).status).toBe(400);
    expect(errorOf(() => validateChatRequest({ message: "x".repeat(2001) })).status).toBe(400);
    expect(validateChatRequest({ message: "x".repeat(2000) }).message).toHaveLength(2000);
  });
});

describe("ids", () => {
  it("validates control ids and analysis ids", () => {
    expect(validateControlId("CDX-021")).toBe("CDX-021");
    expect(errorOf(() => validateControlId("a b")).status).toBe(400);
    expect(isValidAnalysisId("3f2b8c1e-5d47-4a0b-9c3e-0123456789ab")).toBe(true);
    expect(isValidAnalysisId("not-a-uuid")).toBe(false);
    expect(isValidAnalysisId("../../etc")).toBe(false);
  });
});

describe("body handling", () => {
  it("reads bodies within the limit", async () => {
    expect(await readLimitedText(streamOf('{"a":', "1}"), null, 100)).toBe('{"a":1}');
    expect(await readLimitedText(null, null, 100)).toBe("");
  });

  it("rejects by Content-Length before reading, and by actual size when the header lies", async () => {
    await expect(readLimitedText(streamOf("x"), "9999", 100)).rejects.toMatchObject({ status: 413 });
    await expect(readLimitedText(streamOf("x".repeat(60), "x".repeat(60)), "5", 100)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large"
    });
  });

  it("parseJsonObject only accepts JSON objects", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(errorOf(() => parseJsonObject("nope")).status).toBe(400);
    expect(errorOf(() => parseJsonObject("[1]")).status).toBe(400);
    expect(errorOf(() => parseJsonObject("null")).status).toBe(400);
  });

  it("requires a JSON content type", () => {
    requireJsonContentType("application/json");
    requireJsonContentType("application/json; charset=utf-8");
    for (const bad of [null, "text/plain", "application/x-www-form-urlencoded", "application/jsonp"]) {
      expect(errorOf(() => requireJsonContentType(bad)).status).toBe(415);
    }
  });
});

describe("checkSameOrigin", () => {
  const url = "https://codex-loop.example.workers.dev/api/analyze";
  it("allows same-origin and header-less (non-browser) requests", () => {
    checkSameOrigin(new Headers({ origin: "https://codex-loop.example.workers.dev" }), url);
    checkSameOrigin(new Headers(), url);
    checkSameOrigin(new Headers({ "sec-fetch-site": "same-origin" }), url);
  });

  it("blocks cross-origin browsers", () => {
    expect(errorOf(() => checkSameOrigin(new Headers({ origin: "https://evil.example" }), url)).status).toBe(403);
    expect(errorOf(() => checkSameOrigin(new Headers({ origin: "null" }), url)).code).toBe("cross_origin");
    expect(errorOf(() => checkSameOrigin(new Headers({ "sec-fetch-site": "cross-site" }), url)).status).toBe(403);
    expect(
      errorOf(() => checkSameOrigin(new Headers({ origin: "http://codex-loop.example.workers.dev" }), url)).status
    ).toBe(403);
  });
});
