/**
 * Error model shared by every HTTP surface. All failures leave the Worker as
 * `{ error: { code, message, requestId } }`; stack traces and upstream bodies never do.
 */

export type ApiErrorCode =
  | "bad_request"
  | "bad_input"
  | "not_found"
  | "not_analyzed"
  | "forbidden"
  | "empty"
  | "rate_limited"
  | "github_rate_limited"
  | "upstream"
  | "payload_too_large"
  | "unsupported_media_type"
  | "method_not_allowed"
  | "cross_origin"
  | "ai_unavailable"
  | "report_too_large"
  | "internal";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type GitHubErrorKindLike =
  | "bad_input"
  | "not_found"
  | "rate_limited"
  | "forbidden"
  | "empty"
  | "upstream";

export interface GitHubErrorLike {
  kind: GitHubErrorKindLike;
  message: string;
  status?: number;
  retryAfterSeconds?: number;
}

const KINDS: readonly string[] = ["bad_input", "not_found", "rate_limited", "forbidden", "empty", "upstream"];

/** Structural check so this module never needs the (runtime) core import. */
export function isGitHubErrorLike(e: unknown): e is GitHubErrorLike {
  if (typeof e !== "object" || e === null) return false;
  const o = e as { name?: unknown; kind?: unknown };
  return o.name === "GitHubError" && typeof o.kind === "string" && KINDS.includes(o.kind);
}

/** Kinds where retrying the same request cannot succeed. */
export function isPermanentGitHubKind(kind: string): boolean {
  return kind === "bad_input" || kind === "not_found" || kind === "forbidden" || kind === "empty";
}

/** Longest GitHub rate-limit wait we will ride out with step retries (10s+20s+40s+80s of backoff). */
export const MAX_RETRYABLE_RATE_LIMIT_SECONDS = 120;

/** Should the analyze step be retried? Permanent failures and hour-long rate limits are not. */
export function isRetryableGitHubFailure(kind: string, retryAfterSeconds?: number): boolean {
  if (isPermanentGitHubKind(kind)) return false;
  if (kind === "rate_limited" && typeof retryAfterSeconds === "number" && retryAfterSeconds > MAX_RETRYABLE_RATE_LIMIT_SECONDS) {
    return false;
  }
  return true;
}

/** Message carried through Workflow error state: "[kind|ra=SECONDS] text". Decoded by parseWorkflowError. */
export function encodeWorkflowError(e: GitHubErrorLike): string {
  const ra =
    e.kind === "rate_limited" && typeof e.retryAfterSeconds === "number" && e.retryAfterSeconds > 0
      ? `|ra=${Math.min(Math.ceil(e.retryAfterSeconds), 3600)}`
      : "";
  return `[${e.kind}${ra}] ${safeMessage(e.message)}`;
}

const MAX_MESSAGE = 300;

/** Strip anything token-shaped and bound the length before a message reaches a client or log. */
export function safeMessage(input: unknown, fallback = "Unexpected error"): string {
  const raw = input instanceof Error ? input.message : typeof input === "string" ? input : "";
  const cleaned = raw
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > MAX_MESSAGE ? `${cleaned.slice(0, MAX_MESSAGE - 1)}…` : cleaned;
}

/** GitHubError.kind -> HTTP. rate_limited is a 503 (our upstream is throttled, not the caller). */
export function mapGitHubError(e: GitHubErrorLike): ApiError {
  const message = safeMessage(e.message, "GitHub request failed");
  switch (e.kind) {
    case "bad_input":
      return new ApiError(400, "bad_input", message);
    case "not_found":
      return new ApiError(404, "not_found", message);
    case "forbidden":
      return new ApiError(403, "forbidden", message);
    case "empty":
      return new ApiError(422, "empty", message);
    case "rate_limited":
      return new ApiError(
        503,
        "github_rate_limited",
        "GitHub's API rate limit was reached. Try again shortly.",
        clampRetry(e.retryAfterSeconds)
      );
    case "upstream":
    default:
      return new ApiError(502, "upstream", "GitHub returned an unexpected response. Try again shortly.");
  }
}

function clampRetry(seconds: number | undefined): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return 60;
  return Math.min(Math.max(Math.ceil(seconds), 1), 3600);
}

/** Anything thrown that is not already an ApiError becomes a generic 500 with no details. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isGitHubErrorLike(e)) return mapGitHubError(e);
  return new ApiError(500, "internal", "Something went wrong on our side. Please try again.");
}

export interface ErrorBody {
  error: { code: ApiErrorCode; message: string; requestId: string };
}

export function errorBody(err: ApiError, requestId: string): ErrorBody {
  return { error: { code: err.code, message: err.message, requestId } };
}

/**
 * Workflow failures surface as free text (`instance.status().error`). The analyze step prefixes
 * permanent/terminal GitHub failures with `[kind]`, which we turn back into a stable code.
 */
export function parseWorkflowError(error: { name?: string; message?: string } | undefined): {
  code: ApiErrorCode;
  message: string;
  retryAfterSeconds?: number;
} {
  const text = `${error?.message ?? ""}`;
  const storage = /\[(too_large|storage)\]/.exec(text)?.[1];
  if (storage === "too_large") {
    return { code: "report_too_large", message: "This repository's report is too large to store." };
  }
  if (storage === "storage") {
    return { code: "internal", message: "The analysis finished but its result could not be stored. Please try again." };
  }
  // The engine may wrap the message (e.g. `Step threw a NonRetryableError with message "..."`), so search for the tag.
  const m = /\[(bad_input|not_found|rate_limited|forbidden|empty|upstream)(?:\|ra=(\d+))?\]\s*(.*?)"?\s*$/s.exec(text);
  const kindFromName = /GitHubError:(\w+)/.exec(error?.name ?? "")?.[1];
  const kind = m?.[1] ?? (kindFromName && KINDS.includes(kindFromName) ? kindFromName : undefined);
  if (kind) {
    const ra = m?.[2] ? Number(m[2]) : undefined;
    const mapped = mapGitHubError({
      kind: kind as GitHubErrorKindLike,
      message: m?.[3] || text,
      ...(ra !== undefined ? { retryAfterSeconds: ra } : {})
    });
    return {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.retryAfterSeconds !== undefined && kind === "rate_limited" ? { retryAfterSeconds: mapped.retryAfterSeconds } : {})
    };
  }
  return { code: "internal", message: "The analysis failed unexpectedly. Please try again." };
}
