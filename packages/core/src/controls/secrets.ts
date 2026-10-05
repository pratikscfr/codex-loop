import type { Control, Evidence } from "../types.ts";
import { prefetch, remainingBudget } from "../snapshot.ts";
import { basename, capList, isVendored, lineOf, NON_PROD } from "../util.ts";
import { fail, pass, unknown } from "./helpers.ts";

const ENV_IGNORE = /^(\*\*\/|\/)?(\*)?\.env(\*|\.\*|\.local|\.\*\.local|\.[A-Za-z0-9_*]+)?$|^\*\.env$/;

export const GITIGNORE_ENV: Control = {
  id: "CDX-030",
  title: ".gitignore keeps local environment files out of git",
  category: "secrets",
  severity: "medium",
  rationale: "Local .env files routinely hold real credentials. One `git add .` without an ignore rule is how most committed secrets happen.",
  remediation: "Add `.env`, `.env.*` (with `!.env.example`) and, for Cloudflare Workers projects, `.dev.vars` to .gitignore.",
  agentRule: "Never commit .env or .dev.vars files; put real values in untracked local files and document variable names in .env.example.",
  appliesTo: (p) => p.ecosystems.length > 0 || p.hasWrangler || p.hasDocker,
  async check({ snapshot, profile }) {
    const candidates = ["(root)", ...snapshot.paths.filter((p) => basename(p) === ".gitignore" && p !== ".gitignore" && !isVendored(p)).slice(0, 8)];
    let envIgnored = false;
    let devVarsIgnored = !profile.hasWrangler;
    let readAny = false;
    for (const c of candidates) {
      const path = c === "(root)" ? ".gitignore" : c;
      if (!snapshot.paths.includes(path)) continue;
      const text = await snapshot.read(path);
      if (text === null) continue;
      readAny = true;
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("!")) continue;
        if (ENV_IGNORE.test(line)) envIgnored = true;
        if (/^(\*\*\/|\/)?\.dev\.vars(\*|\.\*)?$/.test(line)) devVarsIgnored = true;
      }
      if (envIgnored && devVarsIgnored) break;
    }
    if (!readAny) return fail({ message: "No .gitignore found; local environment files could be committed by accident." });
    const problems: Evidence[] = [];
    if (!envIgnored) problems.push({ path: ".gitignore", message: "No rule ignoring .env files." });
    if (!devVarsIgnored) problems.push({ path: ".gitignore", message: "Wrangler project without a rule ignoring .dev.vars." });
    return problems.length ? fail(...problems) : pass({ path: ".gitignore", message: "Environment files are ignored." });
  }
};

const SAFE_ENV_SUFFIX = /^(example|sample|template|tpl|dist|defaults|schema|test|ci|development|dev)$/i;

export const COMMITTED_SECRET_FILES: Control = {
  id: "CDX-031",
  title: "No credential files are committed",
  category: "secrets",
  severity: "high",
  defaultMode: "enforce",
  rationale: "Committed .env files, private keys and keystores live forever in git history and in every clone and fork.",
  remediation: "Remove the file from the repository, rotate anything it contained, and add it to .gitignore. Rewriting history alone does not un-leak a secret.",
  agentRule: "Do not create or commit .env, .dev.vars, private keys, keystores or credential files; use .env.example with placeholder values.",
  async check({ snapshot }) {
    const hits: Evidence[] = [];
    for (const p of snapshot.paths) {
      if (isVendored(p) || NON_PROD.test(p)) continue;
      const name = basename(p);
      const env = /^\.env(?:\.(.+))?$/.exec(name);
      if (env) {
        // ".env" and ".env.local" are risky; ".env.example" is a template. ".env.development.local"
        // has a safe-looking part but is still a local override, so every part must be safe.
        const parts = env[1] ? env[1].split(".") : [];
        const safe = parts.length > 0 && parts.every((s) => SAFE_ENV_SUFFIX.test(s));
        if (!safe) hits.push({ path: p, message: "Environment file is tracked; verify it holds no secrets and untrack it." });
        continue;
      }
      if (name === ".dev.vars" || /^\.dev\.vars\.(?!example|sample|template)/.test(name)) {
        hits.push({ path: p, message: "Wrangler local secrets file is tracked." });
      } else if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) {
        hits.push({ path: p, message: "SSH private key is tracked." });
      } else if (/\.(p12|pfx|jks|keystore)$/i.test(name)) {
        hits.push({ path: p, message: "Keystore/certificate bundle is tracked." });
      } else if (/(^|\/)\.aws\/credentials$/.test(p) || name === ".pgpass" || name === ".htpasswd") {
        hits.push({ path: p, message: "Credential file is tracked." });
      }
    }
    return hits.length ? fail(...capList(hits, 10, (n) => ({ message: `...and ${n} more.` }))) : pass({ message: "No credential files are tracked." });
  }
};

interface SecretPattern {
  name: string;
  re: RegExp;
  /** Show the first characters of the match (never for private keys). */
  showPrefix: boolean;
}

const PATTERNS: SecretPattern[] = [
  { name: "AWS access key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, showPrefix: true },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, showPrefix: false },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, showPrefix: true },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, showPrefix: true },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, showPrefix: true },
  { name: "Stripe live secret key", re: /\bsk_live_[0-9a-zA-Z]{20,}\b/g, showPrefix: true },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, showPrefix: true },
  { name: "npm access token", re: /\bnpm_[A-Za-z0-9]{36}\b/g, showPrefix: true }
];

/** Rejects obvious placeholders like AKIAXXXXXXXXXXXXXXXX or ghp_000000000000000000000000000000000000. */
function looksReal(match: string): boolean {
  if (/EXAMPLE$/i.test(match)) return false;
  const tail = match.replace(/^[A-Za-z]+[_-]/, "");
  return new Set(tail).size >= 8;
}

const CONFIGISH = /\.(json|ya?ml|toml|ini|cfg|conf|properties|tfvars|tf|env|xml|gradle|sh|bash|zsh|plist)$/i;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp)$/i;
const SKIP_SCAN = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.(lock|min\.js|map|snap|svg|lockb)$/i;

function scanPriority(path: string): number {
  const name = basename(path);
  if (/^\.env/.test(name) || /^(\.npmrc|\.pypirc|\.netrc|credentials)$/.test(name) || name === ".dev.vars") return 0;
  if (CONFIGISH.test(name) || /^Dockerfile/i.test(name)) return 1;
  if (SOURCE.test(name)) return 2;
  return 99;
}

export const SECRET_SCAN: Control = {
  id: "CDX-032",
  title: "No high-confidence secrets in tracked files",
  category: "secrets",
  severity: "critical",
  defaultMode: "enforce",
  rationale: "API keys and private keys in source are harvested by bots within minutes of being pushed to a public repository, and are reused by anyone with clone access to a private one.",
  remediation: "Revoke and rotate the credential first, then remove it from the code and load it from the environment or a secrets manager.",
  agentRule: "Never write API keys, tokens or private keys into code, tests, docs, comments or examples; read them from environment variables.",
  async check({ snapshot }) {
    const candidates = snapshot.paths
      .filter((p) => !isVendored(p) && !NON_PROD.test(p) && !SKIP_SCAN.test(p) && scanPriority(p) < 99)
      .sort((a, b) => scanPriority(a) - scanPriority(b) || a.length - b.length);
    if (candidates.length === 0) return pass({ message: "No scannable text files." });

    const budget = remainingBudget(snapshot);
    const toScan = Number.isFinite(budget) ? candidates.slice(0, Math.max(0, budget)) : candidates;
    await prefetch(snapshot, toScan);

    const hits: Evidence[] = [];
    let scanned = 0;
    for (const path of toScan) {
      let text: string | null;
      try {
        text = await snapshot.read(path);
      } catch {
        continue;
      }
      if (text === null) continue;
      scanned++;
      for (const { name, re, showPrefix } of PATTERNS) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          if (!looksReal(m[0])) continue;
          const shown = showPrefix ? ` (starts with ${m[0].slice(0, 4)}...)` : "";
          hits.push({ path, line: lineOf(text, m.index ?? 0), message: `Possible ${name}${shown}. Value hidden.` });
        }
      }
    }

    if (hits.length) return fail(...capList(hits, 12, (n) => ({ message: `...and ${n} more possible secret(s).` })));
    const coverage = scanned / candidates.length;
    const summary = `Scanned ${scanned} of ${candidates.length} candidate file(s).`;
    if (coverage < 0.5) return unknown(`${summary} Too little was scanned to call this clean; run the CLI locally or raise the read budget for full coverage.`);
    return pass({ message: `No high-confidence secrets found. ${summary}` });
  }
};
