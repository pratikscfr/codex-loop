/**
 * Sliding-window rate limiting math + policy. The Durable Object in ../rate-limiter.ts stores the
 * hit timestamps; everything decidable without I/O lives here so it is unit-testable.
 */

export interface RateRule {
  /** Bucket name inside the limiter instance. */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/** Per-client rules (hourly windows, as requested by the product spec). */
export const RULES = {
  analyze: { bucket: "analyze", limit: 20, windowSeconds: 3600 },
  chat: { bucket: "chat", limit: 60, windowSeconds: 3600 },
  /**
   * Cheap, always-applied first gate: every request that would touch a per-repo Durable Object (and
   * MCP session creation) is charged here *before* the DO is reached, so cache hits and probes for
   * random owner/repo names are metered too.
   */
  read: { bucket: "read", limit: 300, windowSeconds: 3600 }
} as const satisfies Record<string, RateRule>;

/** Protects the shared GitHub quota / Workers AI spend regardless of how many IPs show up. */
export const GLOBAL_RULES = {
  analyze: { bucket: "analyze", limit: 500, windowSeconds: 3600 },
  chat: { bucket: "chat", limit: 2000, windowSeconds: 3600 }
} as const satisfies Record<string, RateRule>;

/** Longest window any rule may use; the limiter deletes hits older than this. */
export const MAX_WINDOW_SECONDS = 3600;

export interface WindowDecision {
  allowed: boolean;
  limit: number;
  /** Requests still available in the window after this one (0 when denied). */
  remaining: number;
  /** Seconds until a denied request could succeed (0 when allowed). */
  retryAfterSeconds: number;
}

/**
 * Sliding-log window. `hits` are the timestamps (ms) of previously *allowed* hits.
 * A request costing `weight` hits is allowed when `count + weight <= limit`, where count is the
 * number of hits inside (now - window, now].
 */
export function evaluateSlidingWindow(
  nowMs: number,
  hits: readonly number[],
  limit: number,
  windowMs: number,
  weight = 1
): WindowDecision {
  const w = Math.max(1, Math.floor(weight));
  const inWindow = hits.filter((t) => t > nowMs - windowMs && t <= nowMs).sort((a, b) => a - b);
  if (inWindow.length + w <= limit) {
    return { allowed: true, limit, remaining: Math.max(0, limit - inWindow.length - w), retryAfterSeconds: 0 };
  }
  if (w > limit) {
    // Can never fit, however long the caller waits.
    return { allowed: false, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) };
  }
  // Enough old hits must expire that count + weight <= limit: the (count + weight - limit)-th oldest.
  const blocker = inWindow[inWindow.length + w - limit - 1];
  const expiresAt = (blocker ?? nowMs) + windowMs;
  return {
    allowed: false,
    limit,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - nowMs) / 1000))
  };
}

export function rateLimitHeaders(decision: WindowDecision): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining)
  };
  if (!decision.allowed) h["Retry-After"] = String(decision.retryAfterSeconds);
  return h;
}

/** All clients without a Cloudflare-provided address share this single bucket. */
export const UNKNOWN_CLIENT = "unknown";

/**
 * Normalise a client address into the unit we rate-limit on:
 *  - IPv4 (including IPv4-mapped IPv6) -> the address itself;
 *  - IPv6 -> its /64 prefix (a single subscriber is handed a whole /64, so per-address keys are
 *    trivially rotated);
 *  - anything unparsable -> the shared "unknown" bucket.
 */
export function normalizeClientAddress(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip || ip.length > 64) return UNKNOWN_CLIENT;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((o) => Number(o) <= 255) ? ip.split(".").map(Number).join(".") : UNKNOWN_CLIENT;
  }
  if (!ip.includes(":")) return UNKNOWN_CLIENT;

  // IPv4-mapped (::ffff:1.2.3.4) -> the IPv4 address.
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped?.[1]) return normalizeClientAddress(mapped[1]);

  // Expand "::" and keep the first four 16-bit groups.
  let head = ip;
  let tail = "";
  const dbl = ip.indexOf("::");
  if (dbl !== -1) {
    if (ip.indexOf("::", dbl + 1) !== -1) return UNKNOWN_CLIENT;
    head = ip.slice(0, dbl);
    tail = ip.slice(dbl + 2);
  }
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  let groups: string[];
  if (dbl !== -1) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return UNKNOWN_CLIENT;
    groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  } else {
    groups = headGroups;
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return UNKNOWN_CLIENT;
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/** The limiter key material for a request: only `cf-connecting-ip` is trusted (never XFF / X-Real-IP). */
export function clientAddressKey(headers: Headers): string {
  const ip = headers.get("cf-connecting-ip");
  return ip ? normalizeClientAddress(ip) : UNKNOWN_CLIENT;
}

/**
 * Stable, non-reversible per-client key. The raw address is never stored or logged; the hash is
 * only used to pick a limiter Durable Object.
 */
export async function clientKey(headers: Headers): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`codex-loop:${clientAddressKey(headers)}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `ip:${hex.slice(0, 24)}`;
}
