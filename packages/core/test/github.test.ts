import { describe, expect, it } from "./testing.ts";
import { analyzeGitHubRepo, GitHubError, parseRepoInput } from "../src/index.ts";
import { LONG_README, NOW } from "./helpers.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Handler>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({ url: url.href, auth: headers.get("authorization") ?? undefined });
    const key = `${url.origin}${url.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response("not mocked: " + key, { status: 500 });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function repoRoutes(opts: { files?: Record<string, string>; isPrivate?: boolean; pulls?: unknown; truncated?: boolean } = {}) {
  const files = opts.files ?? { "README.md": LONG_README, "package.json": JSON.stringify({ scripts: { test: "x" } }), ".gitignore": ".env\n" };
  const routes: Record<string, Handler> = {
    "https://api.github.com/repos/o/r": () => json({ name: "r", owner: { login: "o" }, private: opts.isPrivate ?? false, default_branch: "main", html_url: "https://github.com/o/r" }),
    "https://api.github.com/repos/o/r/commits/main": () => new Response(SHA, { status: 200 }),
    [`https://api.github.com/repos/o/r/git/trees/${SHA}`]: () =>
      json({ truncated: opts.truncated ?? false, tree: Object.entries(files).map(([path, c]) => ({ path, type: "blob", mode: "100644", size: c.length })) }),
    "https://api.github.com/repos/o/r/pulls": () => json(opts.pulls ?? [])
  };
  for (const [path, content] of Object.entries(files)) {
    routes[`https://raw.githubusercontent.com/o/r/${SHA}/${path}`] = () => new Response(content, { status: 200 });
  }
  return routes;
}

describe("parseRepoInput", () => {
  it("accepts the common forms", () => {
    const want = { owner: "cloudflare", repo: "agents" };
    for (const s of [
      "cloudflare/agents",
      "  cloudflare/agents  ",
      "https://github.com/cloudflare/agents",
      "https://github.com/cloudflare/agents/",
      "https://github.com/cloudflare/agents.git",
      "https://www.github.com/cloudflare/agents/tree/main/packages",
      "http://github.com/cloudflare/agents/pull/12",
      "git@github.com:cloudflare/agents.git"
    ]) {
      expect(parseRepoInput(s), s).toEqual(want);
    }
    expect(parseRepoInput("o/.github")).toEqual({ owner: "o", repo: ".github" });
  });

  it("rejects everything else", () => {
    for (const s of ["", "cloudflare", "a/b/c", "https://gitlab.com/a/b", "https://evil.com/github.com/a/b", "a/..", "../b", "a b/c", "javascript:alert(1)", "x".repeat(400), "https://github.com/onlyowner", "a/b;rm -rf", "a/b?x=1"]) {
      expect(parseRepoInput(s), s).toBeNull();
    }
  });
});

describe("analyzeGitHubRepo", () => {
  it("analyzes a repository end to end and records the exact commit", async () => {
    const { fn } = mockFetch(repoRoutes());
    const report = await analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: fn, now: NOW });
    expect(report.repo).toEqual({ owner: "o", repo: "r", ref: "main", sha: SHA, url: "https://github.com/o/r" });
    expect(report.results.find((r) => r.id === "CDX-001")?.status).toBe("pass");
    expect(report.coverage.filesTotal).toBe(3);
    expect(report.footprint).toBeUndefined();
  });

  it("includes the PR footprint when asked, and survives it failing", async () => {
    const pulls = [{ number: 1, user: { login: "dependabot[bot]", type: "Bot" }, created_at: "2026-09-01T00:00:00Z", merged_at: "2026-09-01T01:00:00Z" }];
    let { fn } = mockFetch(repoRoutes({ pulls }));
    const withPulls = await analyzeGitHubRepo({ owner: "o", repo: "r", includeFootprint: true }, { fetch: fn, now: NOW });
    expect(withPulls.footprint?.sampled).toBe(1);

    const routes = repoRoutes();
    routes["https://api.github.com/repos/o/r/pulls"] = () => json({ message: "boom" }, 500);
    ({ fn } = mockFetch(routes));
    const without = await analyzeGitHubRepo({ owner: "o", repo: "r", includeFootprint: true }, { fetch: fn, now: NOW });
    expect(without.footprint).toBeUndefined();
    expect(without.results.length).toBeGreaterThan(10);
  });

  it("refuses private repositories so a service token can never be used to read them", async () => {
    const { fn, calls } = mockFetch(repoRoutes({ isPrivate: true }));
    await expect(analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: fn, token: "tok" })).rejects.toMatchObject({ kind: "forbidden" });
    expect(calls.length).toBe(1); // stopped before listing files or fetching anything
  });

  it("validates names and refs before making any request", async () => {
    const { fn, calls } = mockFetch(repoRoutes());
    await expect(analyzeGitHubRepo({ owner: "o/../x", repo: "r" }, { fetch: fn })).rejects.toMatchObject({ kind: "bad_input" });
    await expect(analyzeGitHubRepo({ owner: "o", repo: ".." }, { fetch: fn })).rejects.toMatchObject({ kind: "bad_input" });
    await expect(analyzeGitHubRepo({ owner: "o", repo: "r", ref: "../../etc" }, { fetch: fn })).rejects.toMatchObject({ kind: "bad_input" });
    await expect(analyzeGitHubRepo({ owner: "o", repo: "r", ref: "a b" }, { fetch: fn })).rejects.toMatchObject({ kind: "bad_input" });
    expect(calls.length).toBe(0);
  });

  it("maps GitHub failures to typed errors", async () => {
    const cases: Array<[Response, string, boolean]> = [
      [json({ message: "Not Found" }, 404), "not_found", false],
      [json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "retry-after": "42" }), "rate_limited", true],
      [json({ message: "You have exceeded a secondary rate limit" }, 403), "rate_limited", true],
      [json({ message: "slow down" }, 429), "rate_limited", true],
      [json({ message: "Repository access blocked" }, 403), "forbidden", false],
      [json({ message: "unavailable" }, 451), "forbidden", false],
      [json({ message: "oops" }, 502), "upstream", true]
    ];
    for (const [res, kind, transient] of cases) {
      const routes = repoRoutes();
      routes["https://api.github.com/repos/o/r"] = () => res.clone();
      const { fn } = mockFetch(routes);
      try {
        await analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: fn });
        throw new Error("expected rejection");
      } catch (err) {
        expect(err instanceof GitHubError, String(err)).toBe(true);
        expect((err as GitHubError).kind).toBe(kind);
        expect((err as GitHubError).transient).toBe(transient);
      }
    }
    const routes = repoRoutes();
    routes["https://api.github.com/repos/o/r"] = () => json({ message: "x" }, 403, { "x-ratelimit-remaining": "0", "retry-after": "42" });
    await expect(analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: mockFetch(routes).fn })).rejects.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 42 });
  });

  it("reports an empty repository clearly", async () => {
    const routes = repoRoutes();
    routes[`https://api.github.com/repos/o/r/git/trees/${SHA}`] = () => json({ truncated: false, tree: [] });
    await expect(analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: mockFetch(routes).fn })).rejects.toMatchObject({ kind: "empty" });
    const r409 = repoRoutes();
    r409["https://api.github.com/repos/o/r/commits/main"] = () => json({ message: "Git Repository is empty." }, 409);
    await expect(analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: mockFetch(r409).fn })).rejects.toMatchObject({ kind: "empty" });
  });

  it("a rate limit while reading files aborts the run instead of storing a report full of unknowns", async () => {
    const routes = repoRoutes();
    routes[`https://raw.githubusercontent.com/o/r/${SHA}/README.md`] = () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    await expect(analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: mockFetch(routes).fn, now: NOW })).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("missing files (404) are simply absent, not errors", async () => {
    const routes = repoRoutes();
    routes[`https://raw.githubusercontent.com/o/r/${SHA}/package.json`] = () => new Response("", { status: 404 });
    const report = await analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: mockFetch(routes).fn, now: NOW });
    expect(report.results.length).toBeGreaterThan(10);
  });

  it("stays within the subrequest budget on a large repository", async () => {
    const files: Record<string, string> = { "README.md": LONG_README, "package.json": "{}" };
    for (let i = 0; i < 300; i++) files[`src/f${i}.ts`] = "export const x = 1;\n";
    const { fn, calls } = mockFetch(repoRoutes({ files, truncated: true }));
    const report = await analyzeGitHubRepo({ owner: "o", repo: "r", includeFootprint: true }, { fetch: fn, now: NOW, maxFileReads: 25 });
    expect(calls.length).toBeLessThanOrEqual(25 + 5);
    expect(report.coverage.treeTruncated).toBe(true);
    expect(report.coverage.filesRead).toBeLessThanOrEqual(25);
    const scan = report.results.find((r) => r.id === "CDX-032")!;
    expect(scan.status).toBe("unknown"); // tiny coverage must not read as "clean"
  });

  it("sends the token only to the GitHub API, never to raw content, and retries anonymously if it is revoked", async () => {
    const { fn, calls } = mockFetch(repoRoutes());
    await analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: fn, token: "secret-token", now: NOW });
    const rawCalls = calls.filter((c) => c.url.startsWith("https://raw.githubusercontent.com"));
    expect(rawCalls.length).toBeGreaterThan(0);
    expect(rawCalls.every((c) => c.auth === undefined)).toBe(true);
    expect(calls.filter((c) => c.url.startsWith("https://api.github.com")).every((c) => c.auth === "Bearer secret-token")).toBe(true);

    const routes = repoRoutes();
    const base = routes["https://api.github.com/repos/o/r"]!;
    routes["https://api.github.com/repos/o/r"] = (url, init) => (new Headers(init?.headers).get("authorization") ? json({ message: "Bad credentials" }, 401) : base(url, init));
    const retry = mockFetch(routes);
    const report = await analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: retry.fn, token: "revoked", now: NOW });
    expect(report.repo?.sha).toBe(SHA);
  });

  it("skips large and binary files without failing", async () => {
    const files: Record<string, string> = { "README.md": LONG_README, "logo.bin": "PK\u0000\u0003binary", "big.json": "x".repeat(10) };
    const routes = repoRoutes({ files });
    routes[`https://api.github.com/repos/o/r/git/trees/${SHA}`] = () =>
      json({ truncated: false, tree: [
        { path: "README.md", type: "blob", mode: "100644", size: 500 },
        { path: "logo.bin", type: "blob", mode: "100644", size: 10 },
        { path: "big.json", type: "blob", mode: "100644", size: 5_000_000 },
        { path: "link", type: "blob", mode: "120000", size: 5 },
        { path: "sub", type: "commit", mode: "160000" }
      ] });
    const { fn, calls } = mockFetch(routes);
    const report = await analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: fn, now: NOW });
    expect(report.coverage.filesTotal).toBe(3); // symlinks and submodules are excluded
    expect(calls.some((c) => c.url.endsWith("/big.json"))).toBe(false); // too large to even request
  });
});

describe("base URL overrides (test seam)", () => {
  it("routes requests to the override hosts and still sends the token only to the API base", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined });
      if (url.endsWith("/api/repos/o/r")) return json({ name: "r", owner: { login: "o" }, private: false, default_branch: "main", html_url: "https://github.com/o/r" });
      if (url.endsWith("/commits/main")) return new Response(SHA);
      if (url.includes("/git/trees/")) return json({ truncated: false, tree: [{ path: "README.md", type: "blob", mode: "100644", size: 9 }] });
      if (url.includes("/raw/o/r/")) return new Response("# hello");
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const report = await analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: fn, token: "tok", apiBase: "http://mock.local:1/api/", rawBase: "http://mock.local:1/raw", now: NOW });
    expect(report.repo?.sha).toBe(SHA);
    expect(calls.every((c) => c.url.startsWith("http://mock.local:1/"))).toBe(true);
    expect(calls.filter((c) => c.url.includes("/raw/")).every((c) => c.auth === undefined)).toBe(true);
    expect(calls.filter((c) => c.url.includes("/api/")).every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("rejects malformed overrides instead of fetching", async () => {
    const { fn, calls } = mockFetch({});
    for (const apiBase of ["javascript:alert(1)", "ftp://x", "http://x y", "//evil", "http://h/?q=1"]) {
      await expect(analyzeGitHubRepo({ owner: "o", repo: "r" }, { fetch: fn, apiBase })).rejects.toMatchObject({ kind: "bad_input" });
    }
    expect(calls.length).toBe(0);
  });
});
