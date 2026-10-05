/* codex-loop UI. Plain JS, no build step, no inline script (CSP: script-src 'self').
 * Security rule: every string that originates in a repository (paths, evidence, titles...) is
 * rendered with textContent / createTextNode only. href values are built from validated parts. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
  const REPO_LABEL_RE = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;

  // ---------------------------------------------------------------- DOM helpers

  const BLOCKED_ATTRS = /^(on[a-z]+|style|srcdoc|src|formaction)$/i;

  /** Build an element. Strings become text nodes; attributes are allow-checked; href must be github.com. */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = String(value);
      else if (key === "text") node.textContent = String(value);
      else if (key === "href") {
        if (typeof value === "string" && (value.startsWith("https://github.com/") || value.startsWith("#ctl-"))) {
          node.setAttribute("href", value);
        }
      } else if (BLOCKED_ATTRS.test(key)) continue;
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Bound any repository-derived string before it reaches the page (defence in depth; the server clamps too). */
  function clip(value, max = 300) {
    const s = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  // Chat history is private to this browser: a random UUID, sent as X-Session-Id, scopes it server-side.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  function newUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  let sessionIdCache = null;
  function sessionId() {
    if (sessionIdCache) return sessionIdCache;
    let id = null;
    try {
      id = window.localStorage.getItem("codex-loop-session");
    } catch {
      id = null;
    }
    if (!id || !UUID_RE.test(id)) {
      id = newUuid();
      try {
        window.localStorage.setItem("codex-loop-session", id);
      } catch {
        /* private mode: the id lives for this page only */
      }
    }
    sessionIdCache = id;
    return id;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "unknown time" : d.toLocaleString();
  }

  function fmtAgo(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return "just now";
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
    if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
    return rtf.format(-Math.round(s / 86400), "day");
  }

  function fmtHours(h) {
    if (h === null || h === undefined || !Number.isFinite(h)) return null;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${(h / 24).toFixed(1)} days`;
  }

  function fmtWait(seconds) {
    const s = Math.max(1, Math.round(seconds));
    if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
    const m = Math.ceil(s / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }

  // ---------------------------------------------------------------- API

  class ApiFailure extends Error {
    constructor(code, message, status, retryAfter) {
      super(message);
      this.code = code;
      this.status = status || 0;
      this.retryAfter = retryAfter || 0;
    }
  }

  async function request(path, init) {
    let res;
    try {
      res = await fetch(path, { credentials: "same-origin", ...init });
    } catch {
      throw new ApiFailure("network", "Could not reach the server.", 0, 0);
    }
    return res;
  }

  async function failureFrom(res) {
    let body = null;
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    const err = body && body.error;
    return new ApiFailure(
      (err && err.code) || `http_${res.status}`,
      (err && err.message) || `Request failed (${res.status}).`,
      res.status,
      Number(res.headers.get("retry-after")) || 0
    );
  }

  async function api(path, init) {
    const res = await request(path, init);
    if (!res.ok) throw await failureFrom(res);
    try {
      return await res.json();
    } catch {
      throw new ApiFailure("internal", "The server sent an unreadable response.", res.status, 0);
    }
  }

  function friendly(err) {
    const wait = err.retryAfter ? ` Try again in about ${fmtWait(err.retryAfter)}.` : "";
    switch (err.code) {
      case "bad_input":
      case "bad_request":
        return "That doesn't look like a public GitHub repository. Use owner/name or a github.com link.";
      case "not_found":
        return "We couldn't find that repository. It may be private, renamed or misspelled. Only public repositories can be checked.";
      case "forbidden":
        return "GitHub wouldn't let us read that repository. It may be private, blocked or unavailable.";
      case "empty":
        return "That repository is empty, so there is nothing to check yet.";
      case "github_rate_limited":
        return `GitHub's API rate limit was reached, so we can't read repositories right now.${wait || " Please try again shortly."}`;
      case "rate_limited":
        return `You've reached the usage limit for now.${wait || " Please try again later."}`;
      case "not_analyzed":
        return "This repository hasn't been analyzed yet. Run an analysis first.";
      case "report_too_large":
        return "That repository's report is too large to store, so it can't be shown.";
      case "ai_unavailable":
        return "The AI assistant is unavailable right now. The report itself is unaffected. Please try again shortly.";
      case "network":
        return "Can't reach the server. Check your connection and try again.";
      case "timeout":
        return "The analysis is taking longer than expected. Please try again in a minute.";
      case "cross_origin":
        return "The request was blocked because it came from a different site.";
      case "upstream":
        return "GitHub returned an unexpected response. Please try again shortly.";
      default:
        return "Something went wrong on our side. Please try again.";
    }
  }

  // ---------------------------------------------------------------- state

  const state = {
    owner: "",
    repo: "",
    report: null,
    run: 0,
    busy: false,
    agentsMd: null,
    chatLoaded: false,
    chatBusy: false,
    filter: "all"
  };

  const els = {
    form: $("analyze-form"),
    input: $("repo-input"),
    button: $("analyze-btn"),
    repoError: $("repo-error"),
    progress: $("progress"),
    progressText: $("progress-text"),
    notice: $("notice"),
    noticeText: $("notice-text"),
    noticeRetry: $("notice-retry"),
    results: $("results"),
    head: $("repo-head"),
    summary: $("summary"),
    advisory: $("advisory"),
    controls: $("controls"),
    footprint: $("footprint"),
    trend: $("trend")
  };

  function githubUrl(path) {
    return `https://github.com/${state.owner}/${state.repo}${path || ""}`;
  }

  // ---------------------------------------------------------------- analyze flow

  function parseInput(raw) {
    const text = raw.trim();
    if (!text) return null;
    const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(text);
    if (!m || !NAME_RE.test(m[1]) || !NAME_RE.test(m[2])) return null;
    return { owner: m[1], repo: m[2] };
  }

  function showFieldError(message) {
    els.repoError.textContent = message || "";
    els.repoError.hidden = !message;
    els.input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function showNotice(message, retry) {
    els.noticeText.textContent = message;
    els.noticeRetry.hidden = !retry;
    els.noticeRetry.onclick = retry || null;
    els.notice.hidden = false;
  }

  function hideNotice() {
    els.notice.hidden = true;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.button.disabled = busy;
    els.input.disabled = busy;
    els.button.textContent = busy ? "Analyzing..." : "Analyze";
    document.querySelectorAll(".chip").forEach((c) => {
      c.disabled = busy;
    });
  }

  function showProgress(text) {
    els.progress.hidden = false;
    els.progressText.textContent = text;
  }

  async function analyze(rawInput) {
    const parsed = parseInput(rawInput);
    showFieldError("");
    hideNotice();
    if (!parsed) {
      showFieldError("Enter a public GitHub repository as owner/name or a github.com URL.");
      els.input.focus();
      return;
    }
    const run = ++state.run;
    const label = `${parsed.owner}/${parsed.repo}`;
    setBusy(true);
    els.results.hidden = true;
    showProgress(`Starting analysis of ${label}...`);
    try {
      const start = await api("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: label })
      });
      const target = REPO_LABEL_RE.exec(String(start.repo || label));
      if (!target) throw new ApiFailure("internal", "Unexpected response.", 0, 0);
      if (!start.cached) await pollAnalysis(start.id, label, run);
      if (run !== state.run) return;
      await loadReport(target[1], target[2], run);
      history.replaceState(null, "", `?repo=${encodeURIComponent(label)}`);
    } catch (e) {
      if (run !== state.run) return;
      const failure = e instanceof ApiFailure ? e : new ApiFailure("internal", "", 0, 0);
      showNotice(friendly(failure), () => analyze(rawInput));
    } finally {
      if (run === state.run) {
        els.progress.hidden = true;
        setBusy(false);
      }
    }
  }

  async function pollAnalysis(id, label, run) {
    const started = Date.now();
    let failures = 0;
    for (let i = 0; ; i++) {
      if (run !== state.run) return;
      let status;
      try {
        status = await api(`/api/analysis/${encodeURIComponent(id)}`);
        failures = 0;
      } catch (e) {
        // Tolerate brief network blips while the workflow keeps running.
        if (e instanceof ApiFailure && e.code === "network" && ++failures < 4) {
          await sleep(2000);
          continue;
        }
        throw e;
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (status.status === "complete") return;
      if (status.status === "errored" || status.status === "terminated") {
        const err = status.error || {};
        throw new ApiFailure(err.code || "internal", err.message || "", 0, Number(err.retryAfterSeconds) || 0);
      }
      const phase =
        status.status === "queued"
          ? "Waiting for a worker"
          : elapsed < 6
            ? "Reading the repository tree"
            : "Evaluating controls and checking pull requests";
      const slow = elapsed > 25 ? " Large repositories can take up to a minute." : "";
      showProgress(`${phase} for ${label}... ${elapsed}s.${slow}`);
      if (Date.now() - started > 180000) throw new ApiFailure("timeout", "", 0, 0);
      await sleep(i < 20 ? 1500 : 3000);
    }
  }

  async function loadReport(owner, repo, run) {
    const data = await api(`/api/report/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if (run !== state.run) return;
    state.owner = owner;
    state.repo = repo;
    state.report = data.report;
    state.agentsMd = null;
    state.chatLoaded = false;
    renderReport(data.report, Array.isArray(data.history) ? data.history : []);
    resetTabs();
  }

  // ---------------------------------------------------------------- report rendering

  const CATEGORY_ORDER = ["hygiene", "ci", "supply-chain", "secrets", "containers", "cloudflare", "quality", "agents"];
  const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const STATUS_ORDER = { fail: 0, unknown: 1, pass: 2, na: 3, suppressed: 4 };
  const STATUS_LABEL = {
    pass: "✓ pass",
    fail: "✗ fail",
    unknown: "? unknown",
    na: "– n/a",
    suppressed: "⏸ suppressed"
  };
  const MODE_HELP = {
    audit: "audit (recorded only)",
    warn: "warn (surfaced, does not block)",
    enforce: "enforce (fails CI when this control fails)"
  };

  function statusKey(r) {
    return r.exception ? "suppressed" : r.status;
  }

  function safeId(id) {
    return `ctl-${String(id).replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  }

  function renderReport(report, historyItems) {
    renderHead(report);
    renderSummary(report);
    renderAdvisory(report);
    renderControls(report);
    renderFootprint(report);
    renderTrend(historyItems);
    els.results.hidden = false;
    els.head.setAttribute("tabindex", "-1");
    els.head.focus({ preventScroll: false });
  }

  function renderHead(report) {
    clear(els.head);
    const cov = report.coverage || {};
    const ref = report.repo && report.repo.ref;
    const sha = report.repo && report.repo.sha;
    const left = el("div", null);
    left.append(el("h2", null, el("a", { href: githubUrl(), rel: "noopener noreferrer" }, `${state.owner}/${state.repo}`)));
    const meta = el("p", { class: "repo-meta" });
    if (ref) meta.append(el("span", null, `ref ${ref}`));
    if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
      meta.append(el("span", null, "commit ", el("a", { href: githubUrl(`/commit/${sha}`), rel: "noopener noreferrer" }, el("code", null, sha.slice(0, 7)))));
    }
    meta.append(el("span", null, el("time", { datetime: report.generatedAt, title: fmtDate(report.generatedAt) }, `analyzed ${fmtAgo(report.generatedAt) || fmtDate(report.generatedAt)}`)));
    if (report.engineVersion) meta.append(el("span", null, `engine ${report.engineVersion}`));
    left.append(meta);

    const notes = [];
    notes.push(`Read ${cov.filesRead ?? 0} of ${cov.filesTotal ?? 0} files.`);
    if (cov.treeTruncated) {
      notes.push("The repository is very large and its file list was truncated, so some controls may be unknown.");
    }
    if (report.profile && report.profile.languages && report.profile.languages.length) {
      notes.push(`Detected: ${report.profile.languages.slice(0, 4).join(", ")}.`);
    }
    const coverage = el("div", { class: `coverage${cov.treeTruncated ? " warn" : ""}` }, el("p", null, notes.join(" ")));
    if (report.configIssues && report.configIssues.length) {
      coverage.append(
        el("p", null, `${report.configIssues.length} problem(s) in .codex-loop.yml (defaults were used): `, report.configIssues.slice(0, 3).map((c) => clip(c)).join("; "))
      );
    }
    els.head.append(left, coverage);
  }

  function renderSummary(report) {
    clear(els.summary);
    const s = report.summary || {};
    const stats = [
      ["pass", s.pass, "Passing"],
      ["fail", s.fail, "Failing"],
      ["unknown", s.unknown, "Unknown"],
      ["na", s.na, "Not applicable"],
      ["suppressed", s.suppressed, "Suppressed"],
      ["blocking", s.blocking, "Would fail CI"]
    ];
    for (const [cls, n, label] of stats) {
      els.summary.append(el("div", { class: `stat ${cls}` }, el("div", { class: "n" }, String(n ?? 0)), el("div", { class: "l" }, label)));
    }
    const sev = s.bySeverity || {};
    const parts = Object.keys(SEVERITY_ORDER).filter((k) => sev[k]).map((k) => `${sev[k]} ${k}`);
    if (parts.length) {
      els.summary.append(el("div", { class: "stat" }, el("div", { class: "l" }, "Failing by severity"), el("div", null, parts.join(", "))));
    }
  }

  function renderAdvisory(report) {
    const a = report.advisory;
    clear(els.advisory);
    if (!a || !a.summary) {
      els.advisory.hidden = true;
      return;
    }
    els.advisory.append(
      el("h2", { id: "h-advisory" }, "AI advisory"),
      el("p", null, el("span", { class: "ai-badge" }, "AI-generated suggestion — not a verified finding")),
      el("p", { class: "hint" }, `Written by ${a.generatedBy || "an AI model"} on ${fmtDate(a.generatedAt)}. Each item below cites a control that failed deterministically; the wording and ordering are the model's.`),
      el("p", null, a.summary)
    );
    if (Array.isArray(a.priorities) && a.priorities.length) {
      const list = el("ol", null);
      for (const p of a.priorities) {
        list.append(
          el(
            "li",
            null,
            el("strong", null, el("a", { href: `#${safeId(p.controlId)}`, "data-open-control": safeId(p.controlId) }, String(p.controlId))),
            ` — ${p.why}`,
            el("br", null),
            el("em", null, `First step: ${p.firstStep}`)
          )
        );
      }
      els.advisory.append(list);
    }
    els.advisory.hidden = false;
  }

  function blobUrlFor(path, line) {
    const r = state.report && state.report.repo;
    const at = (r && (r.sha || r.ref)) || "HEAD";
    if (!path || path.length > 500 || /[\u0000-\u001f]/.test(path)) return null;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const encRef = String(at).split("/").map(encodeURIComponent).join("/");
    return githubUrl(`/blob/${encRef}/${encoded}${Number.isInteger(line) && line > 0 ? `#L${line}` : ""}`);
  }

  function renderControl(r) {
    const key = statusKey(r);
    const details = el("details", { class: "control", id: safeId(r.id), "data-status": key });
    details.append(
      el(
        "summary",
        null,
        el("span", { class: `chip-status ${key}` }, STATUS_LABEL[key] || key),
        el("span", { class: `chip-sev ${r.severity}` }, r.severity),
        el("span", { class: "cid" }, r.id),
        el("span", { class: "ctitle" }, r.title)
      )
    );
    const body = el("div", { class: "body" });
    if (r.rationale) body.append(el("h4", null, "Why it matters"), el("p", null, r.rationale));
    if (r.remediation && (r.status === "fail" || r.status === "unknown")) {
      body.append(el("h4", null, "How to fix"), el("p", null, r.remediation));
    }
    if (r.evidence && r.evidence.length) {
      const list = el("ul", { class: "evidence" });
      for (const ev of r.evidence.slice(0, 30)) {
        const loc = ev.path ? `${clip(ev.path)}${Number.isInteger(ev.line) ? `:${ev.line}` : ""}` : null;
        const href = ev.path ? blobUrlFor(ev.path, ev.line) : null;
        const li = el("li", null);
        if (loc) li.append(href ? el("a", { class: "loc", href, rel: "noopener noreferrer" }, loc) : el("span", { class: "loc" }, loc));
        li.append(el("span", { class: "msg" }, clip(ev.message)));
        list.append(li);
      }
      body.append(el("h4", null, "Evidence"), list);
    }
    if (r.exception) {
      body.append(
        el("h4", null, "Exception"),
        el("p", null, `Suppressed: ${clip(r.exception.reason)} (expires ${clip(r.exception.expires, 20)}${r.exception.owner ? `, owner ${clip(r.exception.owner)}` : ""}).`)
      );
    }
    if (r.expiredException) {
      body.append(el("p", { class: "field-error" }, `An exception expired on ${r.expiredException.expires}, so this failure is live again.`));
    }
    if (r.note) body.append(el("h4", null, "Note"), el("p", null, clip(r.note)));
    body.append(el("h4", null, "Rollout mode"), el("p", null, MODE_HELP[r.mode] || String(r.mode)));
    details.append(body);
    return details;
  }

  function renderControls(report) {
    clear(els.controls);
    const groups = new Map();
    for (const r of report.results || []) {
      if (!groups.has(r.category)) groups.set(r.category, []);
      groups.get(r.category).push(r);
    }
    const cats = [...groups.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || String(a).localeCompare(String(b));
    });
    for (const cat of cats) {
      const items = groups.get(cat).slice().sort((a, b) => {
        return (
          (STATUS_ORDER[statusKey(a)] ?? 9) - (STATUS_ORDER[statusKey(b)] ?? 9) ||
          (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
          String(a.id).localeCompare(String(b.id))
        );
      });
      const failing = items.filter((r) => statusKey(r) === "fail").length;
      const section = el("section", { class: "category", "data-category": cat });
      section.append(
        el("h3", null, String(cat).replace(/-/g, " "), el("span", { class: "count" }, `${items.length} control${items.length === 1 ? "" : "s"}${failing ? `, ${failing} failing` : ""}`))
      );
      for (const r of items) section.append(renderControl(r));
      els.controls.append(section);
    }
    if (!cats.length) els.controls.append(el("p", { class: "hint" }, "No controls were evaluated for this repository."));
    applyFilter(state.filter);
  }

  function applyFilter(filter) {
    state.filter = filter;
    document.querySelectorAll(".filter").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
    els.controls.querySelectorAll(".control").forEach((d) => {
      d.hidden = filter !== "all" && d.dataset.status !== filter;
    });
    els.controls.querySelectorAll(".category").forEach((s) => {
      s.hidden = ![...s.querySelectorAll(".control")].some((d) => !d.hidden);
    });
  }

  const CLASS_INFO = {
    "ai-agent": ["AI agent", "Opened by an AI coding agent"],
    "ai-signal": ["AI-assisted", "Shows signals of AI assistance"],
    automation: ["Automation", "Bots such as dependency updaters"],
    "no-signal": ["No signal", "No AI signal detected; a lower bound on human work, not proof"]
  };

  function renderFootprint(report) {
    const f = report.footprint;
    clear(els.footprint);
    els.footprint.append(el("h2", { id: "h-footprint" }, "Agent footprint"));
    if (!f || !Array.isArray(f.buckets)) {
      els.footprint.append(el("p", { class: "hint" }, "Agent footprint was not collected for this report (GitHub pull-request data was unavailable)."));
      return;
    }
    const total = f.buckets.reduce((n, b) => n + (b.count || 0), 0) || 1;
    els.footprint.append(
      el("p", null, `Classification of ${f.sampled} recent pull request${f.sampled === 1 ? "" : "s"} (${f.merged} merged) over the last ${f.windowDays} days, based on visible signals.`)
    );
    const table = el("table", null);
    table.append(
      el("thead", null, el("tr", null, el("th", { scope: "col" }, "Pull request class"), el("th", { scope: "col", class: "num" }, "PRs"), el("th", { scope: "col", class: "num" }, "Median time to merge")))
    );
    const tbody = el("tbody", null);
    for (const b of f.buckets) {
      const info = CLASS_INFO[b.class] || [String(b.class), ""];
      const share = Math.round(((b.count || 0) / total) * 100);
      const bar = el("span", { class: "share", "aria-hidden": "true" }, el("i", null));
      bar.firstChild.style.width = `${share}%`;
      const median = fmtHours(b.medianHoursToMerge);
      tbody.append(
        el(
          "tr",
          null,
          el("th", { scope: "row" }, info[0], info[1] ? el("div", { class: "hint" }, info[1]) : null, bar),
          el("td", { class: "num" }, `${b.count} (${share}%)`),
          el("td", { class: "num", title: median ? "" : "Too few merged pull requests to report a median" }, median || "n/a")
        )
      );
    }
    table.append(tbody);
    els.footprint.append(table, el("p", { class: "caveat" }, el("strong", null, "Caveat: "), f.caveat));
  }

  function renderTrend(items) {
    clear(els.trend);
    if (!items || items.length < 2) {
      els.trend.hidden = true;
      return;
    }
    const fails = items.map((h) => h.fail);
    const max = Math.max(1, ...fails);
    const w = 14;
    const h = 48;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "spark");
    svg.setAttribute("width", String(items.length * (w + 4)));
    svg.setAttribute("height", String(h));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Failing controls over the last ${items.length} analyses: ${fails.join(", ")}`);
    fails.forEach((n, i) => {
      const bh = Math.max(2, Math.round((n / max) * (h - 4)));
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(i * (w + 4)));
      rect.setAttribute("y", String(h - bh));
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(bh));
      rect.setAttribute("rx", "2");
      if (n === 0) rect.setAttribute("class", "ok");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${fmtDate(items[i].generatedAt)}: ${n} failing`;
      rect.append(title);
      svg.append(rect);
    });
    els.trend.append(
      el("h2", { id: "h-trend" }, "Trend"),
      el("div", { class: "trend-row" }, svg, el("p", { class: "hint" }, `Failing controls across the last ${items.length} analyses (oldest to newest): ${fails.join(" → ")}.`))
    );
    els.trend.hidden = false;
  }

  // ---------------------------------------------------------------- tabs

  const tabs = ["results", "context", "ci", "chat"].map((name) => ({
    name,
    tab: $(`tab-${name}`),
    panel: $(`panel-${name}`)
  }));

  function selectTab(name, focus) {
    for (const t of tabs) {
      const on = t.name === name;
      t.tab.setAttribute("aria-selected", String(on));
      t.tab.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
      if (on && focus) t.tab.focus();
    }
    if (name === "context") loadAgentsMd();
    if (name === "chat") loadChat();
  }

  function resetTabs() {
    selectTab("results", false);
  }

  tabs.forEach((t, i) => {
    t.tab.addEventListener("click", () => selectTab(t.name, false));
    t.tab.addEventListener("keydown", (e) => {
      let next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) {
        e.preventDefault();
        selectTab(next.name, true);
      }
    });
  });

  // ---------------------------------------------------------------- agent context + CI

  const CI_YAML = `# .github/workflows/codex-loop.yml
# EDIT BEFORE USE: replace <full-commit-sha> with a full 40-character commit SHA of
# pratikscfr/codex-loop. The action lives in the action/ subdirectory of that repository.
name: codex-loop
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  standards:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check repository standards
        uses: pratikscfr/codex-loop/action@<full-commit-sha> # <-- EDIT: pin a full commit SHA (invalid until edited)
`;

  const CI_CONFIG = `# .codex-loop.yml (repository root)
version: 1
mode: audit # audit -> warn -> enforce, promoted as the team is ready
`;

  $("ci-yaml").firstElementChild.textContent = CI_YAML;
  $("ci-config").firstElementChild.textContent = CI_CONFIG;

  async function loadAgentsMd() {
    if (state.agentsMd !== null || !state.owner) return;
    const code = $("agents-md").firstElementChild;
    code.textContent = "Loading...";
    try {
      const res = await request(`/api/agents-md/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}`);
      if (!res.ok) throw await failureFrom(res);
      state.agentsMd = await res.text();
      code.textContent = state.agentsMd;
    } catch (e) {
      code.textContent = e instanceof ApiFailure ? friendly(e) : "Could not load AGENTS.md.";
    }
  }

  async function copyText(text, preId, statusId) {
    const status = $(statusId);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied to clipboard.";
    } catch {
      const pre = $(preId);
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      status.textContent = "Press Ctrl/Cmd+C to copy the selected text.";
    }
  }

  $("copy-agents").addEventListener("click", async () => {
    await loadAgentsMd();
    if (state.agentsMd) copyText(state.agentsMd, "agents-md", "agents-status");
  });
  $("download-agents").addEventListener("click", async () => {
    await loadAgentsMd();
    if (!state.agentsMd) return;
    const url = URL.createObjectURL(new Blob([state.agentsMd], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "AGENTS.md";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("copy-ci").addEventListener("click", () => copyText(CI_YAML, "ci-yaml", "ci-status"));
  $("copy-ci-config").addEventListener("click", () => copyText(CI_CONFIG, "ci-config", "ci-status"));

  // ---------------------------------------------------------------- chat

  const chatLog = $("chat-log");
  const chatInput = $("chat-input");
  const chatSend = $("chat-send");
  const chatError = $("chat-error");
  const SUGGESTIONS = ["Which failures should I fix first?", "Summarize this repo's status.", "What does the agent footprint say?"];

  function bubble(role, text, extraClass) {
    const b = el("div", { class: `msg-bubble ${role}${extraClass ? ` ${extraClass}` : ""}` });
    if (role === "assistant") b.append(el("span", { class: "msg-label" }, "AI answer (grounded in this report)"));
    const body = el("span", { class: "msg-text" }, text);
    b.append(body);
    chatLog.append(b);
    chatLog.scrollTop = chatLog.scrollHeight;
    return body;
  }

  function renderSuggestions() {
    const old = $("chat-suggestions");
    if (old) old.remove();
    const box = el("div", { class: "chips", id: "chat-suggestions", role: "group", "aria-label": "Suggested questions" });
    for (const q of SUGGESTIONS) {
      const b = el("button", { type: "button", class: "chip" }, q);
      b.addEventListener("click", () => sendChat(q));
      box.append(b);
    }
    chatLog.after(box);
  }

  async function loadChat() {
    if (state.chatLoaded || !state.owner) return;
    state.chatLoaded = true;
    clear(chatLog);
    chatError.hidden = true;
    try {
      const data = await api(`/api/chat/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}`, {
        headers: { "x-session-id": sessionId() }
      });
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      for (const m of msgs) bubble(m.role === "assistant" ? "assistant" : "user", String(m.content));
      if (!msgs.length) renderSuggestions();
      else $("chat-suggestions")?.remove();
    } catch (e) {
      state.chatLoaded = false;
      chatError.textContent = e instanceof ApiFailure ? friendly(e) : "Could not load the conversation.";
      chatError.hidden = false;
    }
  }

  async function sendChat(message) {
    const text = message.trim();
    if (!text || state.chatBusy || !state.owner) return;
    state.chatBusy = true;
    chatSend.disabled = true;
    chatError.hidden = true;
    $("chat-suggestions")?.remove();
    bubble("user", text);
    chatInput.value = "";
    updateCount();
    const out = bubble("assistant", "Thinking...");
    chatLog.setAttribute("aria-busy", "true");
    try {
      const res = await request(`/api/chat/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": sessionId() },
        body: JSON.stringify({ message: text })
      });
      if (!res.ok) throw await failureFrom(res);
      if (!res.body) {
        out.textContent = await res.text();
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          out.textContent = acc;
          chatLog.scrollTop = chatLog.scrollHeight;
        }
        acc += decoder.decode();
        out.textContent = acc.trim() || "(no answer)";
      }
    } catch (e) {
      const failure = e instanceof ApiFailure ? e : new ApiFailure("network", "", 0, 0);
      out.textContent = friendly(failure);
      out.parentElement.classList.add("error");
      out.parentElement.classList.remove("assistant");
      const label = out.parentElement.querySelector(".msg-label");
      if (label) label.textContent = "Error";
    } finally {
      state.chatBusy = false;
      chatSend.disabled = false;
      chatLog.removeAttribute("aria-busy");
      chatInput.focus();
    }
  }

  function updateCount() {
    const n = chatInput.value.length;
    $("chat-count").textContent = n > 1500 ? `${n}/2000` : "";
  }

  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendChat(chatInput.value);
  });
  chatInput.addEventListener("input", updateCount);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat(chatInput.value);
    }
  });

  // ---------------------------------------------------------------- wiring

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!state.busy) analyze(els.input.value);
  });

  document.querySelectorAll(".chips .chip[data-repo]").forEach((chip) => {
    chip.addEventListener("click", () => {
      els.input.value = chip.dataset.repo;
      analyze(chip.dataset.repo);
    });
  });

  document.querySelectorAll(".filter").forEach((b) => b.addEventListener("click", () => applyFilter(b.dataset.filter)));

  // Advisory links jump to a control: make sure it is visible and expanded first.
  document.addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest("[data-open-control]") : null;
    if (!link) return;
    applyFilter("all");
    const target = document.getElementById(link.getAttribute("data-open-control") || "");
    if (target && target.tagName === "DETAILS") target.open = true;
  });

  // ?repo= only pre-fills the field: an analysis (which spends shared quota) always needs a click.
  const initial = new URLSearchParams(location.search).get("repo");
  if (initial) els.input.value = initial.slice(0, 300);
})();
