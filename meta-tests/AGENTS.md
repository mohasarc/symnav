# `meta-tests` — agent guide

This package holds tests that assert properties of the **workspace itself**
(project-reference graph, ESLint boundaries config, etc.). It has no
production code, intentionally ships no `tsconfig.json`, and is private.

When adding a test here, the rule of thumb: it should fail if someone
silently relaxes a repo-level invariant. If the test instead exercises a
production feature, it belongs next to that feature (see `AGENTS.md` test
conventions for unit / integration / e2e placement).

Tests read config files from disk by path relative to repo root; do not
import from `@symnav/testing` unless a workspace-level helper genuinely
needs it. Keep this package's `tsconfig.test.json` references list as
narrow as possible — the package is meant to depend on nothing.
