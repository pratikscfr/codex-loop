import { describe, it, expect } from "../../../packages/core/test/testing.ts";
import {
  GLOBAL_RULES,
  RULES,
  UNKNOWN_CLIENT,
  clientAddressKey,
  clientKey,
  evaluateSlidingWindow,
  normalizeClientAddress,
  rateLimitHeaders
} from "../src/lib/ratelimit.ts";

const HOUR = 3600_000;

describe("evaluateSlidingWindow", () => {
  it("allows until the limit is reached, counting down remaining", () => {
    const now = 10 * HOUR;
    expect(evaluateSlidingWindow(now, [], 3, HOUR)).toEqual({ allowed: true, limit: 3, remaining: 2, retryAfterSeconds: 0 });
    expect(evaluateSlidingWindow(now, [now - 10], 3, HOUR).remaining).toBe(1);
    expect(evaluateSlidingWindow(now, [now - 20, now - 10], 3, HOUR).remaining).toBe(0);
  });

  it("denies at the limit and reports when the oldest hit expires", () => {
    const now = 10 * HOUR;
    const hits = [now - 50 * 60_000, now - 30 * 60_000, now - 10 * 60_000];
    const d = evaluateSlidingWindow(now, hits, 3, HOUR);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    // oldest hit is 50 min old -> frees up in 10 minutes
    expect(d.retryAfterSeconds).toBe(600);
  });

  it("ignores hits outside the window (expired) and future-dated noise", () => {
    const now = 10 * HOUR;
    expect(evaluateSlidingWindow(now, [now - HOUR - 1, now - 2 * HOUR], 1, HOUR).allowed).toBe(true);
    // A hit exactly `window` ago has expired.
    expect(evaluateSlidingWindow(now, [now - HOUR], 1, HOUR).allowed).toBe(true);
    expect(evaluateSlidingWindow(now, [now + 5_000], 1, HOUR).allowed).toBe(true);
  });

  it("retryAfter is at least one second and handles hits over the limit (limit lowered)", () => {
    const now = 10 * HOUR;
    const d = evaluateSlidingWindow(now, [now - HOUR + 100, now - 50, now - 20], 2, HOUR);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    // 3 hits, limit 2: need 2 to expire; the 2nd oldest (now-50) expires in just under an hour.
    expect(d.retryAfterSeconds).toBe(3600);
  });

  it("unsorted input gives the same answer", () => {
    const now = 10 * HOUR;
    const a = evaluateSlidingWindow(now, [now - 1000, now - 5000, now - 3000], 3, HOUR);
    const b = evaluateSlidingWindow(now, [now - 5000, now - 3000, now - 1000], 3, HOUR);
    expect(a).toEqual(b);
  });
});

describe("policy", () => {
  it("matches the product limits", () => {
    expect(RULES.analyze.limit).toBe(20);
    expect(RULES.analyze.windowSeconds).toBe(3600);
    expect(RULES.chat.limit).toBe(60);
    expect(GLOBAL_RULES.analyze.limit).toBeGreaterThan(RULES.analyze.limit);
  });

  it("emits Retry-After only when denied", () => {
    expect(rateLimitHeaders({ allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0 })).toEqual({
      "X-RateLimit-Limit": "20",
      "X-RateLimit-Remaining": "19"
    });
    const denied = rateLimitHeaders({ allowed: false, limit: 20, remaining: 0, retryAfterSeconds: 120 });
    expect(denied["Retry-After"]).toBe("120");
  });
});

describe("weighted hits (one request paying for several operations)", () => {
  const now = 10 * HOUR;

  it("a request of weight N needs N free slots", () => {
    expect(evaluateSlidingWindow(now, [], 20, HOUR, 3)).toEqual({ allowed: true, limit: 20, remaining: 17, retryAfterSeconds: 0 });
    const nineteen = Array.from({ length: 19 }, (_, i) => now - 1000 - i);
    expect(evaluateSlidingWindow(now, nineteen, 20, HOUR, 1).allowed).toBe(true);
    expect(evaluateSlidingWindow(now, nineteen, 20, HOUR, 2).allowed).toBe(false);
  });

  it("retryAfter waits for enough old hits to expire for the whole weight", () => {
    // limit 3, two hits (40 min and 20 min old); a weight-3 request needs BOTH to expire.
    const hits = [now - 40 * 60_000, now - 20 * 60_000];
    const d = evaluateSlidingWindow(now, hits, 3, HOUR, 3);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(40 * 60); // the newer hit (20 min old) frees up in 40 minutes
    // weight 2 only needs the older one to expire (20 minutes)
    expect(evaluateSlidingWindow(now, hits, 3, HOUR, 2).retryAfterSeconds).toBe(20 * 60);
  });

  it("a request heavier than the limit can never pass", () => {
    const d = evaluateSlidingWindow(now, [], 3, HOUR, 4);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(3600);
  });

  it("weight defaults to one and non-positive weights are treated as one", () => {
    expect(evaluateSlidingWindow(now, [], 1, HOUR).allowed).toBe(true);
    expect(evaluateSlidingWindow(now, [], 1, HOUR, 0).allowed).toBe(true);
    expect(evaluateSlidingWindow(now, [now - 5], 1, HOUR, 0).allowed).toBe(false);
  });
});

describe("read rule (first gate)", () => {
  it("is a cheap, generous per-client budget applied before any per-repo Durable Object", () => {
    expect(RULES.read.limit).toBe(300);
    expect(RULES.read.windowSeconds).toBe(3600);
    expect(RULES.read.limit).toBeGreaterThan(RULES.analyze.limit);
  });
});

describe("client addressing", () => {
  it("keys IPv4 on the address and IPv6 on the /64 prefix", () => {
    expect(normalizeClientAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeClientAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    // every address in the same /64 collapses to one key
    expect(normalizeClientAddress("2001:db8:1:2::1")).toBe(normalizeClientAddress("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"));
    // a different /64 is a different client
    expect(normalizeClientAddress("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(normalizeClientAddress("2001:db8:1:3::1") === normalizeClientAddress("2001:db8:1:2::1")).toBe(false);
  });

  it("handles compressed, bracketed, zoned, upper-case and loopback forms", () => {
    expect(normalizeClientAddress("::1")).toBe("0:0:0:0::/64");
    expect(normalizeClientAddress("[2001:DB8::5]")).toBe("2001:db8:0:0::/64");
    expect(normalizeClientAddress("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(normalizeClientAddress("2001:db8::")).toBe("2001:db8:0:0::/64");
  });

  it("maps IPv4-mapped IPv6 to the IPv4 address", () => {
    expect(normalizeClientAddress("::ffff:198.51.100.9")).toBe("198.51.100.9");
  });

  it("sends garbage to the shared unknown bucket", () => {
    for (const bad of ["", "not an ip", "1.2.3", "999.1.1.1", "1:2:3", "2001:db8::1::2", "g::1", "x".repeat(100)]) {
      expect(normalizeClientAddress(bad)).toBe(UNKNOWN_CLIENT);
    }
  });

  it("trusts only cf-connecting-ip: XFF / X-Real-IP are ignored and absence means one shared bucket", () => {
    const spoofed = new Headers({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" });
    expect(clientAddressKey(spoofed)).toBe(UNKNOWN_CLIENT);
    expect(clientAddressKey(new Headers())).toBe(UNKNOWN_CLIENT);
    expect(clientAddressKey(new Headers({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "6.6.6.6" }))).toBe("198.51.100.1");
  });
});

describe("clientKey", () => {
  it("is stable, hashed, and never contains the address", async () => {
    const a = await clientKey(new Headers({ "cf-connecting-ip": "203.0.113.7" }));
    const b = await clientKey(new Headers({ "cf-connecting-ip": "203.0.113.7" }));
    const c = await clientKey(new Headers({ "cf-connecting-ip": "203.0.113.8" }));
    expect(a).toBe(b);
    expect(a === c).toBe(false);
    expect(a.includes("203.0.113")).toBe(false);
    expect(a).toMatch(/^ip:[0-9a-f]{24}$/);
  });

  it("IPv6 clients in one /64 share a key; rotating the low 64 bits does not evade the limit", async () => {
    const a = await clientKey(new Headers({ "cf-connecting-ip": "2001:db8:1:2::1" }));
    const b = await clientKey(new Headers({ "cf-connecting-ip": "2001:db8:1:2:dead:beef:0:7" }));
    const other = await clientKey(new Headers({ "cf-connecting-ip": "2001:db8:1:9::1" }));
    expect(a).toBe(b);
    expect(a === other).toBe(false);
  });

  it("all requests without cf-connecting-ip (even with spoofed proxy headers) share the unknown bucket", async () => {
    const none = await clientKey(new Headers());
    const spoof = await clientKey(new Headers({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }));
    expect(none).toBe(spoof);
  });
});
