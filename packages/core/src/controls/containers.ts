import type { Control, Evidence } from "../types.ts";
import { prefetch } from "../snapshot.ts";
import { capList, isVendored, NON_PROD } from "../util.ts";
import { fail, pass, unknown } from "./helpers.ts";

const DOCKERFILE = /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.dockerfile)$/i;
const MAX_DOCKERFILES = 10;

interface Instruction {
  op: string;
  args: string;
  line: number;
}

/** Split a Dockerfile into instructions, joining backslash continuations and dropping comments. */
export function parseDockerfile(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const startLine = i + 1;
    while (/\\\s*$/.test(line) && i + 1 < lines.length) {
      i++;
      const next = lines[i]!;
      if (/^\s*#/.test(next)) continue;
      line = line.replace(/\\\s*$/, " ") + next;
    }
    const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(line.replace(/\\\s*$/, ""));
    if (m) out.push({ op: m[1]!.toUpperCase(), args: m[2]!.trim(), line: startLine });
  }
  return out;
}

function dockerfiles(paths: readonly string[]): string[] {
  return paths.filter((p) => DOCKERFILE.test(p) && !isVendored(p) && !NON_PROD.test(p)).slice(0, MAX_DOCKERFILES);
}

export const DOCKER_BASE_PINNED: Control = {
  id: "CDX-040",
  title: "Docker base images are tagged or pinned",
  category: "containers",
  severity: "medium",
  rationale: "`FROM node` or `FROM node:latest` builds a different image tomorrow than today. A specific tag (better: a digest) makes builds reproducible and lets scanners reason about what shipped.",
  remediation: "Use a specific version tag such as `node:22-alpine`, or pin a digest with `@sha256:...`.",
  agentRule: "Never use `latest` or untagged Docker base images; pin a specific version tag or digest.",
  appliesTo: (p) => p.hasDocker,
  async check({ snapshot }) {
    const files = dockerfiles(snapshot.paths);
    if (files.length === 0) return pass({ message: "No Dockerfiles in production paths." });
    await prefetch(snapshot, files);
    const bad: Evidence[] = [];
    let checked = 0;
    for (const file of files) {
      const text = await snapshot.read(file);
      if (text === null) continue;
      checked++;
      const stages = new Set<string>();
      for (const ins of parseDockerfile(text)) {
        if (ins.op !== "FROM") continue;
        const m = /^(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(ins.args);
        if (!m) continue;
        const image = m[1]!;
        const alias = m[2];
        if (alias) stages.add(alias.toLowerCase());
        if (image.toLowerCase() === "scratch" || stages.has(image.toLowerCase()) || image.includes("$")) continue;
        if (image.includes("@sha256:")) continue;
        const lastSlash = image.lastIndexOf("/");
        const colon = image.indexOf(":", lastSlash + 1);
        const tag = colon === -1 ? undefined : image.slice(colon + 1);
        if (!tag) bad.push({ path: file, line: ins.line, message: `${image} has no tag (implicitly :latest).` });
        else if (tag.toLowerCase() === "latest") bad.push({ path: file, line: ins.line, message: `${image} uses the :latest tag.` });
      }
    }
    if (checked === 0) return unknown("Dockerfiles could not be read.");
    return bad.length ? fail(...capList(bad, 10, (n) => ({ message: `...and ${n} more.` }))) : pass({ message: `Base images pinned in ${checked} Dockerfile(s).` });
  }
};

export const DOCKER_NON_ROOT: Control = {
  id: "CDX-041",
  title: "Containers run as a non-root user",
  category: "containers",
  severity: "medium",
  rationale: "A container that runs as root turns any application-level compromise into root inside the container, which makes escapes and lateral movement far easier.",
  remediation: "Create an unprivileged user and switch to it in the final stage with `USER appuser`.",
  agentRule: "Final Docker stages must switch to a non-root `USER`; do not run application processes as root.",
  appliesTo: (p) => p.hasDocker,
  async check({ snapshot }) {
    const files = dockerfiles(snapshot.paths);
    if (files.length === 0) return pass({ message: "No Dockerfiles in production paths." });
    await prefetch(snapshot, files);
    const bad: Evidence[] = [];
    let checked = 0;
    let indeterminate = 0;
    for (const file of files) {
      const text = await snapshot.read(file);
      if (text === null) continue;
      checked++;
      const ins = parseDockerfile(text);
      const lastFrom = ins.map((i) => i.op).lastIndexOf("FROM");
      if (lastFrom === -1) continue;
      const users = ins.slice(lastFrom).filter((i) => i.op === "USER");
      const last = users[users.length - 1];
      if (!last) {
        bad.push({ path: file, message: "Final stage never sets USER, so it runs as root." });
      } else if (/^(root|0)(:|$)/i.test(last.args)) {
        bad.push({ path: file, line: last.line, message: `Final stage runs as ${last.args}.` });
      } else if (last.args.includes("$")) {
        indeterminate++;
      }
    }
    if (checked === 0) return unknown("Dockerfiles could not be read.");
    if (bad.length) return fail(...capList(bad, 10, (n) => ({ message: `...and ${n} more.` })));
    return indeterminate ? unknown("USER is set from a build argument; cannot verify statically.") : pass({ message: `Non-root USER set in ${checked} Dockerfile(s).` });
  }
};
