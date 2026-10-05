import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import {
  ApiError,
  encodeWorkflowError,
  errorBody,
  isGitHubErrorLike,
  isRetryableGitHubFailure,
  isPermanentGitHubKind,
  mapGitHubError,
  parseWorkflowError,
  safeMessage,
  toApiError
} from "../src/lib/errors.ts";
import { errorResponse, json, methodNotAllowed } from "../src/lib/http.ts";

class FakeGitHubError extends Error {
  override name = "GitHubError";
  constructor(
    public kind: string,
    message: string,
    public status?: number,
    public retryAfterSeconds?: number
  ) {
    super(message);
  }
}

describe("GitHubError -> HTTP mapping", () => {
  it("maps every kind to the documented status", () => {
    const cases: Array<[string, number, string]> = [
      ["bad_input", 400, "bad_input"],
      ["not_found", 404, "not_found"],
      ["forbidden", 403, "forbidden"],
      ["empty", 422, "empty"],
      ["rate_limited", 503, "github_rate_limited"],
      ["upstream", 502, "upstream"]
    ];
    for (const [kind, status, code] of cases) {
      const e = mapGitHubError(new FakeGitHubError(kind, "msg") as never);
      expect(e.status).toBe(status);
      expect(e.code).toBe(code);
    }
  });

  it("carries Retry-After for rate limiting, clamped to a sane range", () => {
    expect(mapGitHubError({ kind: "rate_limited", message: "x", retryAfterSeconds: 42 }).retryAfterSeconds).toBe(42);
    expect(mapGitHubError({ kind: "rate_limited", message: "x" }).retryAfterSeconds).toBe(60);
    expect(mapGitHubError({ kind: "rate_limited", message: "x", retryAfterSeconds: 999999 }).retryAfterSeconds).toBe(3600);
    expect(mapGitHubError({ kind: "rate_limited", message: "x", retryAfterSeconds: -5 }).retryAfterSeconds).toBe(60);
  });

  it("does not forward upstream details for 502s", () => {
    const e = mapGitHubError({ kind: "upstream", message: "internal body: <html>secret</html>", status: 500 });
    expect(e.message.includes("secret")).toBe(false);
  });

  it("recognizes GitHubError structurally and knows which kinds are permanent", () => {
    expect(isGitHubErrorLike(new FakeGitHubError("not_found", "x"))).toBe(true);
    expect(isGitHubErrorLike(new Error("x"))).toBe(false);
    expect(isGitHubErrorLike(new FakeGitHubError("weird", "x"))).toBe(false);
    expect(isGitHubErrorLike(null)).toBe(false);
    for (const k of ["bad_input", "not_found", "forbidden", "empty"]) expect(isPermanentGitHubKind(k)).toBe(true);
    for (const k of ["rate_limited", "upstream"]) expect(isPermanentGitHubKind(k)).toBe(false);
  });
});

describe("toApiError / error bodies", () => {
  it("turns unknown errors into a generic 500 with no internals", () => {
    const e = toApiError(new Error("SELECT * FROM secrets at /src/db.ts:12"));
    expect(e.status).toBe(500);
    expect(e.code).toBe("internal");
    expect(e.message.includes("SELECT")).toBe(false);
    expect(toApiError("string thrown").status).toBe(500);
  });

  it("passes ApiError through and shapes the body", () => {
    const original = new ApiError(429, "rate_limited", "slow down", 30);
    expect(toApiError(original)).toBe(original);
    expect(errorBody(original, "req-1")).toEqual({
      error: { code: "rate_limited", message: "slow down", requestId: "req-1" }
    });
  });

  it("maps GitHubError thrown anywhere", () => {
    expect(toApiError(new FakeGitHubError("not_found", "nope")).status).toBe(404);
  });
});

describe("safeMessage", () => {
  it("redacts token-shaped strings and bounds length", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(safeMessage(`bad credentials ${token}`).includes(token)).toBe(false);
    expect(safeMessage("Authorization: Bearer abcdefghijklmnopqrstuvwx").includes("abcdefghijklmnop")).toBe(false);
    expect(safeMessage("x".repeat(1000)).length).toBeLessThanOrEqual(300);
    expect(safeMessage("line1\nline2\u0000")).toBe("line1 line2");
    expect(safeMessage("", "fallback")).toBe("fallback");
    expect(safeMessage(undefined, "fallback")).toBe("fallback");
  });
});

describe("workflow error decoding", () => {
  it("recovers the GitHub kind from the [kind] prefix", () => {
    expect(parseWorkflowError({ name: "Error", message: "[not_found] Repository not found" })).toEqual({
      code: "not_found",
      message: "Repository not found"
    });
    expect(parseWorkflowError({ name: "Error", message: "[empty] Repo has no files" }).code).toBe("empty");
    expect(parseWorkflowError({ name: "Error", message: "[rate_limited] slow" }).code).toBe("github_rate_limited");
  });

  it("finds the tag even when the engine wraps the message", () => {
    const wrapped = 'Step threw a NonRetryableError with message "[not_found] Repository not found"';
    expect(parseWorkflowError({ name: "WorkflowFatalError", message: wrapped })).toEqual({
      code: "not_found",
      message: "Repository not found"
    });
    const rl = parseWorkflowError({ message: 'prefix [rate_limited|ra=585] GitHub rate limit reached; try again shortly.' });
    expect(rl.code).toBe("github_rate_limited");
    expect(rl.retryAfterSeconds).toBe(585);
  });

  it("maps storage failures to stable, non-retry-worthy codes", () => {
    const big = parseWorkflowError({ message: "[too_large] Report too large to store." });
    expect(big.code).toBe("report_too_large");
    expect(big.message).toMatch(/too large/);
    const stored = parseWorkflowError({ message: 'Step threw a NonRetryableError with message "[storage] Could not store the report."' });
    expect(stored.code).toBe("internal");
    expect(stored.message).toMatch(/could not be stored/);
  });

  it("falls back to the error name, then to a generic message", () => {
    expect(parseWorkflowError({ name: "GitHubError:forbidden", message: "blocked" }).code).toBe("forbidden");
    const generic = parseWorkflowError({ name: "TypeError", message: "x is not a function at worker.js:1" });
    expect(generic.code).toBe("internal");
    expect(generic.message.includes("worker.js")).toBe(false);
    expect(parseWorkflowError(undefined).code).toBe("internal");
  });
});

describe("retry policy", () => {
  it("retries transient failures and short rate limits, never permanent ones or hour-long waits", () => {
    expect(isRetryableGitHubFailure("upstream")).toBe(true);
    expect(isRetryableGitHubFailure("rate_limited")).toBe(true);
    expect(isRetryableGitHubFailure("rate_limited", 30)).toBe(true);
    expect(isRetryableGitHubFailure("rate_limited", 1800)).toBe(false);
    for (const k of ["bad_input", "not_found", "forbidden", "empty"]) expect(isRetryableGitHubFailure(k)).toBe(false);
  });

  it("round-trips kind and retry-after through the workflow error message", () => {
    const encoded = encodeWorkflowError({ kind: "rate_limited", message: "GitHub rate limit reached", retryAfterSeconds: 1234 });
    expect(encoded).toBe("[rate_limited|ra=1234] GitHub rate limit reached");
    const decoded = parseWorkflowError({ name: "Error", message: encoded });
    expect(decoded.code).toBe("github_rate_limited");
    expect(decoded.retryAfterSeconds).toBe(1234);
    expect(encodeWorkflowError({ kind: "not_found", message: "nope", retryAfterSeconds: 5 })).toBe("[not_found] nope");
    expect(parseWorkflowError({ message: "[not_found] nope" }).retryAfterSeconds).toBeUndefined();
  });
});

describe("response shaping", () => {
  it("json() sets security headers and the request id", () => {
    const res = json({ ok: true }, "rid-1");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-request-id")).toBe("rid-1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("errorResponse() uses the standard shape, Retry-After and never a stack trace", async () => {
    const { response, error } = errorResponse(new ApiError(429, "rate_limited", "slow down", 90), "rid-2");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
    const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body).toEqual({ error: { code: "rate_limited", message: "slow down", requestId: "rid-2" } });
    expect(error.status).toBe(429);

    const boom = errorResponse(new Error("kaboom\n    at secret.ts:1:1"), "rid-3");
    const text = await boom.response.text();
    expect(boom.response.status).toBe(500);
    expect(text.includes("kaboom")).toBe(false);
    expect(text.includes("secret.ts")).toBe(false);
  });

  it("methodNotAllowed lists the allowed methods", async () => {
    const res = methodNotAllowed(["GET", "POST"], "rid-4");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});
