/** Response helpers: consistent JSON, security headers and request ids. Pure (web-standard APIs only). */
import { ApiError, errorBody, toApiError } from "./errors.ts";

/** Headers for machine-readable responses. Same-origin only: no CORS headers are ever added. */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store"
};

export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface RespondInit {
  status?: number;
  headers?: Record<string, string>;
}

function baseHeaders(requestId: string, contentType: string, extra?: Record<string, string>): Headers {
  const h = new Headers(API_SECURITY_HEADERS);
  h.set("Content-Type", contentType);
  h.set("X-Request-Id", requestId);
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return h;
}

export function json(data: unknown, requestId: string, init: RespondInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: baseHeaders(requestId, "application/json; charset=utf-8", init.headers)
  });
}

export function text(body: string, requestId: string, contentType: string, init: RespondInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: baseHeaders(requestId, contentType, init.headers)
  });
}

export function streamResponse(
  stream: ReadableStream<Uint8Array>,
  requestId: string,
  contentType: string,
  init: RespondInit = {}
): Response {
  const headers = baseHeaders(requestId, contentType, init.headers);
  headers.set("X-Accel-Buffering", "no");
  return new Response(stream, { status: init.status ?? 200, headers });
}

/** Turn any thrown value into the standard error response (never includes stack traces). */
export function errorResponse(e: unknown, requestId: string): { response: Response; error: ApiError } {
  const err = toApiError(e);
  const headers: Record<string, string> = {};
  if (err.retryAfterSeconds !== undefined) headers["Retry-After"] = String(err.retryAfterSeconds);
  return { response: json(errorBody(err, requestId), requestId, { status: err.status, headers }), error: err };
}

export function methodNotAllowed(allowed: string[], requestId: string): Response {
  const err = new ApiError(405, "method_not_allowed", `Method not allowed. Use ${allowed.join(", ")}.`);
  const { response } = errorResponse(err, requestId);
  response.headers.set("Allow", allowed.join(", "));
  return response;
}
