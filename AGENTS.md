# symnav contributor guide

## Orientation

`symnav` is a language-agnostic CLI for navigating codebases by symbol — definitions, references, and the surrounding context graph.

- [`docs/navigation.md`](docs/navigation.md) — navigation commands, targets, output, errors.
- [`docs/daemon.md`](docs/daemon.md) — workspace daemon, sandbox support, `setup`, `doctor`. Policy values in [`docs/daemon-policy.md`](docs/daemon-policy.md).

## How we work

- Rules live in `.agents/rules/` (coding style, commits, PRs, writing voice) and skills in `.agents/skills/`.
- Project-specific skills end in `+` and are committed, plus `symnav` and `symnav-benchmark-analysis`. The rest are copied from mo-skills and gitignored.
- Keep this file short. Add a fact here only when an agent would otherwise get it wrong.

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
- `pnpm build` — `tsc --build`, then esbuild bundles the CLI into `apps/cli/dist` with `@symnav/*` inlined. CLI tsc output lands in `apps/cli/build`.
- `pnpm --filter symnav dev -- <args>` — run the CLI from source via `tsx` (no build step).

Don't bump versions by hand. release-please owns `version` in `package.json`, `apps/cli/package.json` and `.release-please-manifest.json`, and a meta-test fails if they drift. Don't `npm publish` by hand either. Merging the release PR makes `release.yml` verify, pack, smoke, publish over OIDC, and attach the tarball to the GitHub Release. To retry a failed publish, dispatch `release.yml` with the tag.

## Pre-PR verification

Before opening or pushing to a PR, run the full CI-parity sequence locally on a clean tree:

```
pnpm install --frozen-lockfile && pnpm build && pnpm test \
  && pnpm --filter symnav test:e2e:cold && pnpm --filter symnav test:e2e:warm \
  && pnpm lint && pnpm typecheck
```

The `--frozen-lockfile` install is load-bearing: it's the only step that detects lockfile drift from `package.json` changes. A plain `pnpm install` (or none at all) silently tolerates stale `node_modules` symlinks left over from earlier installs, which can hide a missing dependency declaration that CI will then fail on. Treat anything short of this sequence as not-yet-verified.

## Test conventions

- Unit tests are colocated next to source: `<package>/src/foo.test.ts`.
- Integration tests live under `<package>/test/integration/`.
- End-to-end tests live under `apps/cli/test/e2e/` and spawn the built binary.
- Install-smoke tests live under `apps/cli/test/install-smoke/` and run against a globally installed tarball, not the repo build. `pnpm test` skips them. To run locally: `pnpm --filter symnav pack --pack-destination <dir>`, `npm install -g --prefix <prefix> <dir>/symnav-<version>.tgz`, then `SYMNAV_INSTALL_PREFIX=<prefix> SYMNAV_EXPECTED_VERSION=<version> pnpm --filter symnav test:install-smoke`.
- Fixture projects live under `packages/testing/fixtures/`. Resolve them via `fixturePath("name")` from `@symnav/testing` — never hardcode paths.
- In-memory or mock helpers live beside the tests that use them — not in `@symnav/testing`, which is reserved for cross-cutting test utils with no upstream package deps.
- A fixture's `.git` directory is checked in as `dot-git/` — the host repo would otherwise treat a real nested `.git` as a submodule. The e2e setup renames `dot-git/` to `.git/` via `ensureFixtureGitMarker` before the suite runs. `packages/testing/fixtures/overview-cases/` is the canonical example.
- Try `overview` against the fixture with `pnpm --filter symnav dev -- overview <file>` from inside `packages/testing/fixtures/overview-cases/`, or against any real file with `pnpm --filter symnav dev -- overview path/to/file.ts`.

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
