import { analyzeGitHubRepo, parseRepoInput } from "../packages/core/src/index.ts";
for (const target of process.argv.slice(2)) {
  const p = parseRepoInput(target)!;
  const r = await analyzeGitHubRepo(p, {});
  console.log(`\n== ${target}  (${r.profile.languages.join(",")}; pm=${r.profile.packageManager ?? "-"}; ${r.coverage.filesRead}/${r.coverage.filesTotal} read)`);
  for (const x of r.results) {
    if (x.status === "pass" || x.status === "na") continue;
    const e = x.evidence[0];
    console.log(`${x.status.toUpperCase().padEnd(7)} ${x.id} ${(e?.path ?? "")}${e?.line ? ":" + e.line : ""} ${(e?.message ?? x.note ?? "").slice(0, 110)}`);
  }
}
