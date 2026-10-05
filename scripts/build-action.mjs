import { build } from "esbuild";

// GitHub runs actions straight from the repository, so the bundle is committed (action/dist).
await build({
  entryPoints: ["action/src/index.ts"],
  outfile: "action/dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  legalComments: "none",
  logLevel: "info"
});
