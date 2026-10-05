#!/usr/bin/env node
import { GitHubError } from "@codex-loop/core";
import { main, UsageError } from "./main.ts";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) console.error(`codex-loop: ${err.message}`);
    else if (err instanceof GitHubError) console.error(`codex-loop: ${err.message}${err.retryAfterSeconds ? ` (retry in ~${err.retryAfterSeconds}s)` : ""}`);
    else console.error(`codex-loop: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
);
