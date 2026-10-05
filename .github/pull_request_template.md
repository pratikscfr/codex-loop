## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run typecheck && npm test` pass locally
- [ ] If a control or its text changed: `npm run docs` was run and `docs/CONTROLS.md` is committed
- [ ] If `packages/core`, `packages/cli` or `action/` changed: `npm run build` was run and `action/dist` is committed
- [ ] New or changed controls have pass **and** fail tests, and return `unknown` (never a guess) when they cannot decide
- [ ] Repo-derived strings are escaped (markdown helpers or `textContent`); no secret values are echoed
