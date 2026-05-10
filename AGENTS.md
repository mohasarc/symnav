# symnav contributor guide

## Orientation

`symnav` is a CLI for navigating TypeScript codebases by symbol — definitions, references, and the surrounding context graph. Read [`plans/000/symnav-functional-spec.md`](plans/000/symnav-functional-spec.md) for what it does from a user's perspective, and [`plans/000/symnav-stages.md`](plans/000/symnav-stages.md) for the staged implementation roadmap. Read those for high-level context before changing code.

## Repo layout

- `apps/cli` — the `symnav` binary. Wires Commander, owns the user-facing CLI surface, depends on the three production libraries below.
- `packages/core` — language-agnostic primitives and the cross-language backend interface. Has no internal dependencies.
- `packages/renderer` — output formatters (text, JSON). Depends only on `@symnav/core`.
- `packages/backend-typescript` — the TypeScript language backend. Depends only on `@symnav/core`.
- `packages/testing` — test-only utilities (fixture loader, ESLint config helper, fixtures themselves). Importable from any package's _test_ code; never from production code. Private; never published.

## Day-to-day commands

- `pnpm install` — install workspace dependencies.
- `pnpm test` — run Vitest across the workspace.
- `pnpm lint` — run ESLint (boundaries + Prettier).
- `pnpm typecheck` — TypeScript build + per-package test-config typecheck.
- `pnpm build` — `tsc --build` across the workspace.
- `pnpm --filter symnav dev -- <args>` — run the CLI from source via `tsx` (no build step).

## Pre-PR verification

Before opening or pushing to a PR, run the full CI-parity sequence locally on a clean tree:

```
pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint && pnpm typecheck
```

The `--frozen-lockfile` install is load-bearing: it's the only step that detects lockfile drift from `package.json` changes. A plain `pnpm install` (or none at all) silently tolerates stale `node_modules` symlinks left over from earlier installs, which can hide a missing dependency declaration that CI will then fail on. Treat anything short of this sequence as not-yet-verified.

## Test conventions

- Unit tests are colocated next to source: `<package>/src/foo.test.ts`.
- Integration tests live under `<package>/test/integration/`.
- End-to-end tests live under `apps/cli/test/e2e/` and spawn the built binary.
- Fixture projects live under `packages/testing/fixtures/`. Resolve them via `fixturePath("name")` from `@symnav/testing` — never hardcode paths.
- In-memory or mock helpers live beside the tests that use them — not in `@symnav/testing`, which is reserved for cross-cutting test utils with no upstream package deps.

## TDD

Write the failing test first, then make it pass. Every behavior the code performs should have a test that would fail without it. Commit the red test as its own commit when the failure is informative; otherwise pair it with the implementation. The point is verified intent, not ceremony — small, focused tests that exercise real behavior beat broad tests that prove nothing.

## Project rules

- Avoid comments — meaning comes from clear names. Comments never carry contracts, preconditions, or other load-bearing info; if it matters, encode it in types, names, or tests, where it can't silently rot during a refactor.
- Favor readable names, early returns, and simple control flow over clever code.
- Spell out abbreviations in directory and file names — clarity for every future reader beats brevity once.
- Break large functions into smaller named ones; break long logic chains into named intermediate variables.
- Prefer classes with explicit public/private/static members over scattered functions plus object literals; share logic via abstract classes.
- Define only what you need now when shaping interfaces — defer everything speculative.
- Don't invent preconditions on interfaces. Before stating "caller must do X", name the concrete failure mode if X is skipped. If nothing concretely breaks, the precondition is fictional — drop it, and don't smuggle one layer's responsibilities into another's surface.
- Few things per file (mostly only one): never put multiple classes or top-level functions in one `.ts`.
- If a directory mixes files from two unrelated bounded contexts, split it — the listing should narrate what the package contains.
- Optimise filenames for the `ls`; optimise function names for the call site — they can disagree.
- Loose coupling beats DRY across module boundaries — do not deduplicate across independent modules.
- Prefer clear, small TypeScript modules with explicit types at public boundaries.
- Reuse existing utilities before adding dependencies or new abstractions.
- Keep CLI behavior deterministic, non-interactive by default, and covered by focused tests.
- Update docs and examples whenever command behavior or output changes.

## PR descriptions

Conciseness is non-negotiable. Structure beats wall-of-text. Short prose is fine where bullets would be awkward — pick whichever reads faster.

Writing rules:

- One concrete fact per sentence or bullet. Prefer concrete nouns ("validates input order") over hand-waving ("improves robustness").
- Cut filler: no metaphors, no "really" / "very" / "simply" / "just", no decorative adjectives.
- Drop unnecessary articles where readability holds.
- Skip any section that would be empty or restate the title.

Sections:

- **Why** — the motivation, constraint, or decision a reviewer can't infer from the diff. Skip if the title already says it.
- **Notes** (optional) — call out anything non-obvious: surprising trade-offs, follow-ups deferred, files that look bigger than they are. Skip if there's nothing worth flagging.
- **Test plan** — checklist of what was actually run or verified.

Do not add a "Summary" / "What changed" section — reviewers read the commits and diff for that.

## Dependency direction

The package dependency graph is locked. A given package may import only from the packages listed below.

| Package                      | May depend on (internal)                                         |
| ---------------------------- | ---------------------------------------------------------------- |
| `@symnav/core`               | (nothing)                                                        |
| `@symnav/renderer`           | `@symnav/core`                                                   |
| `@symnav/backend-typescript` | `@symnav/core`                                                   |
| `symnav` (apps/cli)          | `@symnav/core`, `@symnav/renderer`, `@symnav/backend-typescript` |
| `@symnav/testing`            | (nothing)                                                        |

`@symnav/testing` is additionally importable from any package's test files. Production code may not import it.

Two enforcement layers run in CI: TypeScript project references (`pnpm typecheck` — a forbidden import is unresolvable because the importing package's `tsconfig.json` (or `tsconfig.test.json`, for test code) does not list the target as a reference) and ESLint boundaries (`pnpm lint` — `eslint-plugin-boundaries` reports the violation). Both must pass.

Edits to `eslint.config.mjs` or any `tsconfig*.json` are additionally asserted by tests in `meta-tests/` that read those files from disk; run `pnpm test` after touching them.
