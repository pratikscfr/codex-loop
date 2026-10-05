import type { Control } from "../types.ts";
import { fail, pass, unknown } from "./helpers.ts";

export const README: Control = {
  id: "CDX-001",
  title: "README exists and explains the project",
  category: "hygiene",
  severity: "low",
  rationale:
    "A README is the first thing humans and coding agents read. Without it, every newcomer (and every agent session) has to rediscover what the project is and how to run it.",
  remediation: "Add a README.md at the repository root covering what the project does, how to run it, and how to test it.",
  agentRule: "Keep README.md accurate: update it in the same change when setup steps, commands or behavior change.",
  async check({ snapshot }) {
    const file = snapshot.paths.find((p) => /^readme(\.(md|markdown|rst|txt|adoc))?$/i.test(p));
    if (!file) return fail({ message: "No README at the repository root." });
    const text = await snapshot.read(file);
    if (text === null) return unknown(`${file} could not be read.`);
    if (text.trim().length < 200) {
      return fail({ path: file, message: `${file} is only ${text.trim().length} characters; describe what the project is and how to run it.` });
    }
    return pass({ path: file, message: `${file} present (${text.trim().length} characters).` });
  }
};

export const CODEOWNERS: Control = {
  id: "CDX-002",
  title: "CODEOWNERS defines who reviews changes",
  category: "hygiene",
  severity: "medium",
  rationale:
    "Code review only works when the right people are asked. CODEOWNERS routes reviews automatically and makes ownership explicit, which matters more as agents raise the volume of changes.",
  remediation: "Add .github/CODEOWNERS mapping paths to the teams or people who own them.",
  agentRule: "Respect CODEOWNERS: keep changes scoped to one area where possible so the right owners can review them.",
  async check({ snapshot }) {
    const file = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", ".gitlab/CODEOWNERS"].find((p) =>
      snapshot.paths.includes(p)
    );
    if (!file) return fail({ message: "No CODEOWNERS file (looked in root, .github/, docs/)." });
    const text = await snapshot.read(file);
    if (text !== null && !text.split("\n").some((l) => l.trim() && !l.trim().startsWith("#"))) {
      return fail({ path: file, message: `${file} contains no ownership rules.` });
    }
    return pass({ path: file, message: `${file} present.` });
  }
};

export const SECURITY_POLICY: Control = {
  id: "CDX-003",
  title: "Security policy tells people how to report vulnerabilities",
  category: "hygiene",
  severity: "low",
  defaultMode: "audit",
  rationale:
    "Without a documented reporting path, vulnerabilities get reported publicly or not at all. (An organization-level .github repository can supply this; if so, record an exception.)",
  remediation: "Add SECURITY.md describing supported versions and how to report a vulnerability privately.",
  agentRule: "Never put secrets, tokens or exploit details in code, commits, issues or logs; follow SECURITY.md for reporting.",
  async check({ snapshot }) {
    const file = ["SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"].find((p) => snapshot.paths.includes(p));
    return file
      ? pass({ path: file, message: `${file} present.` })
      : fail({ message: "No SECURITY.md (it may be inherited from an organization-level .github repository)." });
  }
};

export const LICENSE: Control = {
  id: "CDX-004",
  title: "License is declared",
  category: "hygiene",
  severity: "low",
  defaultMode: "audit",
  rationale: "A missing license leaves reuse rights undefined, which blocks adoption and complicates compliance reviews.",
  remediation: "Add a LICENSE file, or record an exception for private repositories where it is intentionally absent.",
  agentRule: "Do not copy code from sources whose license is unknown or incompatible with this repository's license.",
  async check({ snapshot }) {
    const file = snapshot.paths.find((p) => /^(LICEN[CS]E|COPYING|UNLICENSE)(\..+)?$/i.test(p));
    return file ? pass({ path: file, message: `${file} present.` }) : fail({ message: "No LICENSE file at the repository root." });
  }
};

const AGENT_CONTEXT = [
  /(^|\/)AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^GEMINI\.md$/,
  /^\.cursorrules$/,
  /^\.windsurfrules$/,
  /^\.clinerules$/,
  /^\.cursor\/rules\//,
  /^\.github\/copilot-instructions\.md$/,
  /^CONVENTIONS\.md$/
];

export const AGENT_CONTEXT_FILE: Control = {
  id: "CDX-070",
  title: "Coding agents have repository context",
  category: "agents",
  severity: "low",
  rationale:
    "Agents that start every session cold re-learn commands and conventions, and tend to invent them. A short AGENTS.md with build/test commands and the rules that matter removes most of that guessing.",
  remediation: "Generate one with `codex-loop context --write`, then edit it. Keep it short and specific to this repo.",
  agentRule: "Read AGENTS.md first and keep it current when commands or conventions change.",
  async check({ snapshot }) {
    const found = snapshot.paths.filter((p) => AGENT_CONTEXT.some((re) => re.test(p)));
    if (found.length === 0) {
      return fail({ message: "No agent context file (AGENTS.md, CLAUDE.md, .cursor/rules, copilot-instructions.md)." });
    }
    return pass({ path: found[0], message: `Agent context present: ${found.slice(0, 3).join(", ")}${found.length > 3 ? ", ..." : ""}.` });
  },
  appliesTo: (p) => p.ecosystems.length > 0 || p.languages.length > 0
};
