# symnav contributor guide

## Orientation

`symnav` is a CLI for navigating TypeScript codebases by symbol — definitions, references, and the surrounding context graph. Read [`plans/000/symnav-functional-spec.md`](plans/000/symnav-functional-spec.md) for what it does from a user's perspective, and [`plans/000/symnav-stages.md`](plans/000/symnav-stages.md) for the staged implementation roadmap. Read those for high-level context before changing code.

## Repo layout

- `apps/cli` — the `symnav` binary. Wires Commander, owns the user-facing CLI surface, depends on the five production libraries below.
- `packages/core` — language-agnostic primitives and the cross-language backend interface. Has no internal dependencies.
- `packages/daemon` — owns portable host contracts plus daemon client, launch/election, registry, transport, process and worker entries, execution/delivery, resources, diagnostics, lifecycle, policy, and the read-only testing surface. Has no internal dependencies.
- `packages/renderer` — output formatters (text, JSON). May depend only on `@symnav/core` and `@symnav/daemon`.
- `packages/backend-typescript` — the TypeScript language backend. Depends only on `@symnav/core`.
- `packages/telemetry` — shape-only usage capture, storage, and aggregation. Has no internal dependencies.
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
- A fixture's `.git` directory is checked in as `dot-git/` — the host repo would otherwise treat a real nested `.git` as a submodule. The e2e setup renames `dot-git/` to `.git/` via `ensureFixtureGitMarker` before the suite runs. `packages/testing/fixtures/overview-cases/` is the canonical example.
- Try `overview` against the fixture with `pnpm --filter symnav dev -- overview <file>` from inside `packages/testing/fixtures/overview-cases/`, or against any real file with `pnpm --filter symnav dev -- overview path/to/file.ts`.

## TDD

Write the failing test first, then make it pass. Every behavior the code performs should have a test that would fail without it. Commit the red test as its own commit when the failure is informative; otherwise pair it with the implementation. The point is verified intent, not ceremony — small, focused tests that exercise real behavior beat broad tests that prove nothing.

## Project rules

- Avoid comments — meaning comes from clear names. Comments never carry contracts, preconditions, or other load-bearing info; if it matters, encode it in types, names, or tests, where it can't silently rot during a refactor.
- Favor readable names, early returns, and simple control flow over clever code.
- Name what a value is, not the generic role it plays, so the name alone tells the reader its meaning. When related types share a member, lift it into a shared base so the commonality is expressed once.
- Spell out abbreviations in directory and file names — clarity for every future reader beats brevity once.
- Break large functions into smaller named ones; break long logic chains into named intermediate variables.
- Group functions into classes with explicit public/private/static members — a file of free functions calling each other is a violation, not a style choice. A function that is internal to a file and called only by other functions there belongs on the class as a private (static when stateless) member. A lone exported free function is acceptable only as a genuinely standalone helper with no in-file collaborators. Any shared or module-level state always lives in a class — never in module-scope variables. Share logic via abstract classes, not object literals.
- Define only what you need now when shaping interfaces — defer everything speculative.
- Don't invent preconditions on interfaces. Before stating "caller must do X", name the concrete failure mode if X is skipped. If nothing concretely breaks, the precondition is fictional — drop it, and don't smuggle one layer's responsibilities into another's surface.
- File boundaries follow architecture, not granularity. A file owns one cohesive unit — a class, an interface, a public function, or a small family of types that travel together — alongside the private helpers and types only it uses. Two failure modes to avoid: co-locating unrelated top-level abstractions in the same `.ts`, and shattering a coherent unit into one-function-per-file scaffolding. A helper that is used in exactly one place, has no independent meaning, and isn't tested on its own belongs inline with its caller; promote it to its own file once any of those changes.
- If a directory mixes files from two unrelated bounded contexts, split it — the listing should narrate what the package contains.
- Optimise filenames for the `ls`; optimise function names for the call site — they can disagree.
- Loose coupling beats DRY across module boundaries — do not deduplicate across independent modules.
- Prefer clear, small TypeScript modules with explicit types at public boundaries.
- Reuse existing utilities before adding dependencies or new abstractions.
- Keep CLI behavior deterministic, non-interactive by default, and covered by focused tests.
- Update docs and examples whenever command behavior or output changes.

## PR descriptions

Use the template at `.github/PULL_REQUEST_TEMPLATE.md`. Per-section purpose is explained inline there.

Writing rules:

- Conciseness is non-negotiable. Structure beats wall-of-text. Short prose is fine where bullets would be awkward — pick whichever reads faster.
- One concrete fact per sentence or bullet. Prefer concrete nouns ("validates input order") over hand-waving ("improves robustness").
- Cut filler: no metaphors, no "really" / "very" / "simply" / "just", no decorative adjectives.
- Drop unnecessary articles where readability holds.
- Skip any section that would be empty or restate the title.
- Do not add a "Summary" / "What changed" section — reviewers read the commits and diff for that.

## Dependency direction

The package dependency graph is locked. A given package may import only from the packages listed below.

| Package                      | May depend on (internal)                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@symnav/core`               | (nothing)                                                                                               |
| `@symnav/daemon`             | (nothing)                                                                                               |
| `@symnav/renderer`           | `@symnav/core`, `@symnav/daemon`                                                                        |
| `@symnav/backend-typescript` | `@symnav/core`                                                                                          |
| `@symnav/telemetry`          | (nothing)                                                                                               |
| `symnav` (apps/cli)          | `@symnav/core`, `@symnav/daemon`, `@symnav/renderer`, `@symnav/backend-typescript`, `@symnav/telemetry` |
| `@symnav/testing`            | (nothing)                                                                                               |

`@symnav/testing` is additionally importable from any package's test files. Production code may not import it.

Two enforcement layers run in CI: TypeScript project references (`pnpm typecheck` — a forbidden import is unresolvable because the importing package's `tsconfig.json` (or `tsconfig.test.json`, for test code) does not list the target as a reference) and ESLint boundaries (`pnpm lint` — `eslint-plugin-boundaries` reports the violation). Both must pass.

Edits to `eslint.config.mjs` or any `tsconfig*.json` are additionally asserted by tests in `meta-tests/` that read those files from disk; run `pnpm test` after touching them.
