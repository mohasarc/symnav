# `meta-tests`

Tests **about the workspace itself** — not about any production code.

These assertions guard the load-bearing repo rules: the locked package
dependency graph (encoded in TypeScript project references), the ESLint
boundaries config (added in stage 0 phase 3), and similar workspace-level
invariants. A failing test here means a config edit silently relaxed a rule
the project relies on.

This package has no production code and intentionally ships no
`tsconfig.json` — only `tsconfig.test.json`. The absence is asserted by
`src/project-refs.test.ts` so the design choice can't drift unnoticed.

Do not put unit, integration, or e2e tests of production features here.
Those belong next to the code they exercise (see `AGENTS.md` test
conventions).
