/**
 * Decide what an MCP HTTP request should cost. The Streamable-HTTP transport accepts JSON-RPC
 * *batches*, so charging one limiter hit per HTTP request would let a single request smuggle any
 * number of analyses. Pure, so it is unit-tested without the runtime.
 */

export const MAX_ANALYZING_CALLS_PER_REQUEST = 3;
export const MAX_MESSAGES_PER_REQUEST = 20;

export interface McpCharges {
  /** `tools/call` messages that can trigger a GitHub analysis. */
  analyzeHits: number;
  /** `initialize` messages (each creates a session Durable Object). */
  initializeHits: number;
  reject?: { status: number; rpcCode: number; message: string };
}

interface RpcLike {
  method?: unknown;
  params?: { name?: unknown };
}

export function planMcpCharges(payload: unknown, analyzingTools: ReadonlySet<string>): McpCharges {
  const messages: unknown[] = Array.isArray(payload) ? payload : payload === undefined ? [] : [payload];
  if (messages.length > MAX_MESSAGES_PER_REQUEST) {
    return {
      analyzeHits: 0,
      initializeHits: 0,
      reject: { status: 400, rpcCode: -32600, message: `Too many messages in one request (max ${MAX_MESSAGES_PER_REQUEST}).` }
    };
  }
  let analyzeHits = 0;
  let initializeHits = 0;
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as RpcLike;
    if (msg.method === "initialize") initializeHits++;
    else if (msg.method === "tools/call" && typeof msg.params?.name === "string" && analyzingTools.has(msg.params.name)) {
      analyzeHits++;
    }
  }
  if (analyzeHits > MAX_ANALYZING_CALLS_PER_REQUEST) {
    return {
      analyzeHits,
      initializeHits,
      reject: {
        status: 400,
        rpcCode: -32600,
        message: `Too many analysis calls in one request (max ${MAX_ANALYZING_CALLS_PER_REQUEST}).`
      }
    };
  }
  if (initializeHits > MAX_ANALYZING_CALLS_PER_REQUEST) {
    return {
      analyzeHits,
      initializeHits,
      reject: { status: 400, rpcCode: -32600, message: "Too many initialize messages in one request." }
    };
  }
  return { analyzeHits, initializeHits };
}

/** JSON-RPC `id` of a single (non-batch) message, for error replies. */
export function rpcIdOf(payload: unknown): string | number | null {
  if (Array.isArray(payload) || typeof payload !== "object" || payload === null) return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/**
 * MCP clients are not browsers, so no CORS headers are sent unless the operator lists allowed
 * origins (comma-separated `MCP_ALLOWED_ORIGINS`). The MCP runtime adds `Access-Control-Allow-Origin: *`
 * on its own; this strips every CORS header and re-adds a specific, allow-listed origin only.
 */
export function applyMcpCors(headers: Headers, requestOrigin: string | null, allowList: readonly string[]): void {
  const existing = [...headers.keys()].filter((k) => k.toLowerCase().startsWith("access-control-"));
  const expose = headers.get("access-control-expose-headers");
  const allowHeaders = headers.get("access-control-allow-headers");
  const allowMethods = headers.get("access-control-allow-methods");
  for (const k of existing) headers.delete(k);
  if (requestOrigin && allowList.includes(requestOrigin)) {
    headers.set("Access-Control-Allow-Origin", requestOrigin);
    headers.append("Vary", "Origin");
    if (expose) headers.set("Access-Control-Expose-Headers", expose);
    if (allowHeaders) headers.set("Access-Control-Allow-Headers", allowHeaders);
    if (allowMethods) headers.set("Access-Control-Allow-Methods", allowMethods);
  }
}

export function parseAllowList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(s));
}
