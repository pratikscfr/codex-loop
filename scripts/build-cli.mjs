import { build } from "esbuild";

// One self-contained file: `node packages/cli/dist/cli.js check .` needs no node_modules.
await build({
  entryPoints: ["packages/cli/src/cli.ts"],
  outfile: "packages/cli/dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
  logLevel: "info"
});
