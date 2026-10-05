/** Differential check: the same repo through the disk snapshot and the GitHub snapshot should agree. */
import { analyze, analyzeGitHubRepo, type Report } from "../packages/core/src/index.ts";
import { createDirectorySnapshot } from "../packages/core/src/node.ts";

const pairs = process.argv.slice(2).map((a) => a.split("=")); // dir=owner/repo
for (const [dir, slug] of pairs) {
  const [owner, repo] = slug!.split("/");
  const local = await analyze(await createDirectorySnapshot(dir!));
  const remote: Report = await analyzeGitHubRepo({ owner: owner!, repo: repo! }, {});
  const diffs: string[] = [];
  for (const l of local.results) {
    const r = remote.results.find((x) => x.id === l.id)!;
    if (l.status !== r.status) diffs.push(`${l.id}: local=${l.status} remote=${r.status}`);
  }
  console.log(`${slug}: ${diffs.length === 0 ? "identical statuses" : diffs.join("; ")}  (local read ${local.coverage.filesRead}/${local.coverage.filesTotal}, remote read ${remote.coverage.filesRead}/${remote.coverage.filesTotal})`);
}
