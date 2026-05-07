# symnav contributor guide

## Orientation

`symnav` is a CLI for navigating TypeScript codebases by symbol — definitions, references, and the surrounding context graph. Read [`plans/000/symnav-functional-spec.md`](plans/000/symnav-functional-spec.md) for what it does from a user's perspective, and [`plans/000/symnav-stages.md`](plans/000/symnav-stages.md) for the staged implementation roadmap. Read those for high-level context before changing code.

## Repo layout

- `apps/cli` — the `symnav` binary. Wires Commander, owns the user-facing CLI surface, depends on the three production libraries below.
- `packages/core` — language-agnostic primitives and the cross-language backend interface. Has no internal dependencies.
- `packages/renderer` — output formatters (text, JSON). Depends only on `@symnav/core`.
- `packages/backend-typescript` — the TypeScript language backend. Depends only on `@symnav/core`.
- `packages/testing` — test-only utilities (fixture loader, ESLint config helper, fixtures themselves). Importable from any package's *test* code; never from production code. Private; never published.

## Day-to-day commands

- `pnpm install` — install workspace dependencies.
- `pnpm test` — run Vitest across the workspace.
- `pnpm lint` — run ESLint (boundaries + Prettier).
- `pnpm typecheck` — TypeScript build + per-package test-config typecheck.
- `pnpm build` — `tsc --build` across the workspace.
- `pnpm --filter symnav dev -- <args>` — run the CLI from source via `tsx` (no build step).

## Test conventions

- Unit tests are colocated next to source: `<package>/src/foo.test.ts`.
- Integration tests live under `<package>/test/integration/`.
- End-to-end tests live under `apps/cli/test/e2e/` and spawn the built binary.
- Fixture projects live under `packages/testing/fixtures/`. Resolve them via `fixturePath("name")` from `@symnav/testing` — never hardcode paths.

## TDD

Write the failing test first, then make it pass. Every behavior the code performs should have a test that would fail without it. Commit the red test as its own commit when the failure is informative; otherwise pair it with the implementation. The point is verified intent, not ceremony — small, focused tests that exercise real behavior beat broad tests that prove nothing.

## Project rules

- Prefer clear, small TypeScript modules with explicit types at public boundaries.
- Keep CLI behavior deterministic, non-interactive by default, and covered by focused tests.
- Reuse existing utilities before adding dependencies or new abstractions.
- Favor readable names, early returns, and simple control flow over clever code.
- Update docs and examples whenever command behavior or output changes.

## Dependency direction

The package dependency graph is locked. A given package may import only from the packages listed below.

| Package | May depend on (internal) |
|---|---|
| `@symnav/core` | (nothing) |
| `@symnav/renderer` | `@symnav/core` |
| `@symnav/backend-typescript` | `@symnav/core` |
| `symnav` (apps/cli) | `@symnav/core`, `@symnav/renderer`, `@symnav/backend-typescript` |
| `@symnav/testing` | `@symnav/core` |

`@symnav/testing` is additionally importable from any package's test files. Production code may not import it.

Two enforcement layers run in CI: TypeScript project references (`pnpm typecheck` — a forbidden import is unresolvable because the importing package's `tsconfig.json` (or `tsconfig.test.json`, for test code) does not list the target as a reference) and ESLint boundaries (`pnpm lint` — `eslint-plugin-boundaries` reports the violation). Both must pass.

Edits to `eslint.config.mjs` or any `tsconfig*.json` are additionally asserted by tests in `meta-tests/` that read those files from disk; run `pnpm test` after touching them.
