# Stage 0 — Project Foundations: Phased Plan

A phased, TDD-driven implementation of [Stage 0 of the symnav stages plan](../symnav-stages.md): the monorepo skeleton, test harness, lint/typecheck/CI pipeline, and the `symnav --version` smoke binary.

## Goal

When this plan is complete:

- `pnpm install && pnpm test` runs green on a clean clone.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build` are all green.
- The built `symnav` binary, when spawned in any directory, prints the version declared in `apps/cli/package.json`. An e2e test exercises this against a fixture project.
- A new contributor opening the repo finds an `AGENTS.md` that explains the layout, commands, and the load-bearing rules in one read.
- Adding a forbidden internal import (e.g. `@symnav/renderer` importing `@symnav/backend-typescript`) fails both the `lint` and `typecheck` CI jobs.

This is the walking skeleton. No command logic, no language-backend behavior beyond an empty interface placeholder if needed, no publishing.

## Context

The repo is greenfield. Today, the root contains only:

- `AGENTS.md` (5 short project rules), `CLAUDE.md` symlinked to it.
- `.gitignore` (currently ignores `.agents/skills/*`, `skills-lock.json`, `.serena`, `temp/`).
- `plans/000/symnav-stages.md` and `plans/000/symnav-functional-spec.md`.
- `plans/000/stage-0/` — empty; this plan and its downstream artifacts live here.
- Tooling-only directories: `.claude/`, `.serena/`, `.agents/`, `temp/`. None contain runtime code.

No `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `node_modules/`, CI workflow, or any TypeScript source exists yet. Every artifact this plan introduces is brand new.

The package graph (locked in the stages doc and confirmed in drill-down):

| Package | Path | Published as | May depend on (internal) |
|---|---|---|---|
| Core | `packages/core` | `@symnav/core` | (nothing) |
| Renderer | `packages/renderer` | `@symnav/renderer` | `@symnav/core` |
| TS backend | `packages/backend-typescript` | `@symnav/backend-typescript` | `@symnav/core` |
| CLI app | `apps/cli` | `symnav` (unscoped) | `@symnav/core`, `@symnav/renderer`, `@symnav/backend-typescript` |
| Testing | `packages/testing` | `@symnav/testing` (private, never published) | `@symnav/core` |

`@symnav/testing` is a test-only consumer: any package's *test* code may import it, but production code may not.

## Phase 1 — Workspace skeleton with Vitest and placeholder tests

**Behavior delivered.** A pnpm workspace exists with all five packages scaffolded. Vitest runs across the workspace and reports green for the placeholder tests in every package. CI runs `pnpm install --frozen-lockfile` followed by `pnpm test` on every push and PR, and is green. Editor config (`.editorconfig`, `.vscode/`) is committed so format-on-save and indent rules are consistent across contributors.

**Test cases.** One placeholder test per package, asserting the package's main module loads. Each lives at `<package>/src/index.test.ts` (colocated). Each test:
- Imports the package's own `index.ts` and asserts the imported namespace is defined.
- Level: unit.
- Fixture/harness: none beyond Vitest's defaults.

The five tests:
1. `apps/cli/src/index.test.ts` — imports `./index`, asserts it loads.
2. `packages/core/src/index.test.ts` — same shape.
3. `packages/renderer/src/index.test.ts` — same shape.
4. `packages/backend-typescript/src/index.test.ts` — same shape.
5. `packages/testing/src/index.test.ts` — same shape.

These prove each package's Vitest configuration resolves TypeScript and runs a real assertion. They are removed in later phases as real tests appear.

**Components.**

Repo-root files:

- `pnpm-workspace.yaml`:
  ```yaml
  packages:
    - "apps/*"
    - "packages/*"
  ```
- `package.json` (root, private):
  ```jsonc
  {
    "name": "symnav-monorepo",
    "private": true,
    "packageManager": "pnpm@9.12.3",
    "scripts": {
      "test": "pnpm -r run test"
    },
    "devDependencies": {
      "vitest": "^2.x"
    }
  }
  ```
  (Specific minor/patch versions resolved at implementation time; `packageManager` is pinned to a single concrete patch version.)
- `.nvmrc`: contents `20`.
- `.npmrc`:
  ```
  auto-install-peers=true
  strict-peer-dependencies=true
  ```
- `.editorconfig`: UTF-8, LF, 2-space indent, trim trailing whitespace, final newline.
- Update `.gitignore`: add `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`.
- `vitest.config.ts` (root): minimal, declares the workspace's test glob (`**/src/**/*.test.ts`, `**/test/**/*.test.ts`) and `passWithNoTests: false`.
- `.vscode/settings.json`:
  ```jsonc
  {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" },
    "prettier.requireConfig": true
  }
  ```
- `.vscode/extensions.json`:
  ```jsonc
  { "recommendations": ["esbenp.prettier-vscode", "dbaeumer.vscode-eslint"] }
  ```

Per-package files (one set per package; only deltas across packages noted):

- `<package>/package.json`:
  ```jsonc
  {
    "name": "@symnav/<name>",   // or "symnav" for apps/cli
    "version": "0.0.0",
    "private": true,            // remains true for all libs; apps/cli flips to public in Stage 6
    "type": "module",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "scripts": {
      "test": "vitest run"
    }
  }
  ```
- `<package>/src/index.ts`: empty file (`export {};`).
- `<package>/src/index.test.ts`: imports `./index` and asserts the namespace is defined.

CI:

- `.github/workflows/ci.yml`:
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4   # respects packageManager field
        - uses: actions/setup-node@v4
          with:
            node-version-file: .nvmrc
            cache: pnpm
        - run: pnpm install --frozen-lockfile
        - run: pnpm test
  ```
  (`lint`, `typecheck`, `build` jobs are added in their owning phases.)

**Commit plan.**

1. **`Add repo root: pnpm workspace, root package.json, editor and node version pins`**
   Adds `pnpm-workspace.yaml`, root `package.json` (private, pinned `packageManager`), `.nvmrc`, `.npmrc`, `.editorconfig`, and the `.gitignore` additions. *Hygiene: pure addition of root configuration, no packages or code yet.*
2. **`Add Vitest dev dependency and root config`**
   Installs Vitest at the root, commits `vitest.config.ts` and the resulting `pnpm-lock.yaml`. *Hygiene: dependency + config in one commit; nothing yet uses it.*
3. **`Scaffold packages/core with placeholder test`**
   Adds `packages/core/package.json`, `src/index.ts`, `src/index.test.ts`. Test passes. *Hygiene: introduces the package; the placeholder test proves the harness works for this package.*
4. **`Scaffold packages/renderer with placeholder test`**
   Same shape as commit 3, for renderer. *Hygiene: one package, one commit.*
5. **`Scaffold packages/backend-typescript with placeholder test`**
   Same. *Hygiene: one package, one commit.*
6. **`Scaffold packages/testing with placeholder test`**
   Same. *Hygiene: one package, one commit.*
7. **`Scaffold apps/cli with placeholder test`**
   Same; `apps/cli/package.json` uses unscoped name `symnav`. *Hygiene: one package, one commit.*
8. **`Add CI workflow with install and test jobs`**
   Adds `.github/workflows/ci.yml`. *Hygiene: CI introduction is its own commit, decoupled from package scaffolding.*
9. **`Commit VS Code workspace settings and recommended extensions`**
   Adds `.vscode/settings.json` and `.vscode/extensions.json`. *Hygiene: editor config is contributor experience, separate from build/test machinery.*

**Done when.**
- `pnpm install --frozen-lockfile` succeeds locally.
- `pnpm test` runs and reports 5 passing tests.
- A push to a branch produces a green CI run.
- Opening the repo in VS Code with the recommended extensions installed yields format-on-save with no extra setup.

---

## Phase 2 — TypeScript project references and `typecheck` CI

**Behavior delivered.** Every package compiles via `tsc --build` with project references that encode the allowed dependency graph. `pnpm typecheck` runs at the root and is green. The graph is enforced at the type-check layer: a forbidden import (e.g. `@symnav/renderer` importing from `@symnav/backend-typescript`) causes `tsc --build` to fail with "Cannot find module," because the importing package's `tsconfig.json` does not list the forbidden package as a reference. CI gains a `typecheck` job.

**Test cases.**

Type-checking is the test for this phase — `tsc --build --noEmit` running clean on the whole workspace is the pass condition, and a deliberately broken commit (added then immediately reverted on a throwaway branch during implementation, not committed to `main`) verifies the negative case during development. To make the negative case asserted-and-committed:

1. **Forbidden import is unresolvable** — a Vitest test in `packages/testing/src/project-refs.test.ts` reads each production package's `tsconfig.json` and asserts the references list matches the locked allowed-edges table from the Context section. Failure modes covered:
   - `@symnav/renderer`'s `tsconfig.json` references only `@symnav/core`.
   - `@symnav/backend-typescript`'s `tsconfig.json` references only `@symnav/core`.
   - `@symnav/core`'s `tsconfig.json` has no internal references.
   - `apps/cli`'s `tsconfig.json` references all three production libs.
   - No production `tsconfig.json` references `@symnav/testing`.
   - Each package's `tsconfig.test.json` references its production `tsconfig.json` and `@symnav/testing`.
   - Level: unit.
   - Fixture/harness: reads JSON files from disk via `node:fs`, no fixture project required.

The placeholder tests in each package's `index.test.ts` continue to pass; they are not removed in this phase.

**Components.**

- `tsconfig.base.json` (root): shared compiler options.
  ```jsonc
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "lib": ["ES2022"],
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "exactOptionalPropertyTypes": true,
      "declaration": true,
      "declarationMap": true,
      "sourceMap": true,
      "composite": true,
      "incremental": true,
      "outDir": "./dist",
      "rootDir": "./src",
      "esModuleInterop": false,
      "verbatimModuleSyntax": true,
      "skipLibCheck": true
    }
  }
  ```
- `tsconfig.json` (root): meta-config aggregating references.
  ```jsonc
  {
    "files": [],
    "references": [
      { "path": "./packages/core" },
      { "path": "./packages/renderer" },
      { "path": "./packages/backend-typescript" },
      { "path": "./packages/testing" },
      { "path": "./apps/cli" }
    ]
  }
  ```
- `<package>/tsconfig.json`: extends base, lists references per the allowed-edges table.
  Example for `packages/renderer`:
  ```jsonc
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
    "include": ["src/**/*.ts"],
    "exclude": ["src/**/*.test.ts", "**/dist/**"],
    "references": [{ "path": "../core" }]
  }
  ```
- `<package>/tsconfig.test.json`: extends the package's main tsconfig, includes test files, references `@symnav/testing` (when applicable).
  ```jsonc
  {
    "extends": "./tsconfig.json",
    "compilerOptions": { "composite": false, "noEmit": true },
    "include": ["src/**/*.ts", "test/**/*.ts"],
    "references": [
      { "path": "./tsconfig.json" },
      { "path": "../testing" }   // omitted from packages/testing's own tsconfig.test.json
    ]
  }
  ```
- `<package>/package.json`: `scripts` gains `"build": "tsc --build"` and `"typecheck": "tsc --build --noEmit"`. Package metadata gains `"exports"`:
  ```jsonc
  {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    },
    "files": ["dist"]
  }
  ```
- Root `package.json`: `scripts` gains `"typecheck": "tsc --build --noEmit"` and `"build": "tsc --build"`. Adds `"typescript"` to `devDependencies`.
- `.gitignore`: add `*.tsbuildinfo` if not already present from Phase 1.
- `vitest.config.ts`: configure Vitest to honor `tsconfig.test.json` for type resolution (e.g. via `tsconfigPaths` or vitest's native resolver).
- New test file `packages/testing/src/project-refs.test.ts`: reads and asserts the references graph (no helper exports — pure assertion file).
- CI: extend `.github/workflows/ci.yml` to add a `typecheck` job parallel to `test`.

**Commit plan.**

1. **`Add tsconfig.base.json with shared compiler options`**
   Adds the root base config. No package consumes it yet. *Hygiene: type/config introduced without callsites.*
2. **`Add per-package tsconfig.json files with locked references`**
   Adds `tsconfig.json` to each of the five packages, with references matching the allowed-edges table. Adds the root meta `tsconfig.json`. *Hygiene: pure addition; project graph is now declarable.*
3. **`Add per-package tsconfig.test.json for test-time type resolution`**
   Adds the test-only tsconfig in every package, plus updates `vitest.config.ts` to honor it. *Hygiene: test-only configuration, isolated from production tsconfigs.*
4. **`Add typecheck and build scripts to packages and root`**
   Adds `build` and `typecheck` to each `package.json` and at the root. *Hygiene: scripts only, no behavior change beyond making `pnpm typecheck` runnable.*
5. **`Test: assert tsconfig project references match allowed edges`**
   Adds `packages/testing/src/project-refs.test.ts`. Test passes against the references introduced above. *Hygiene: test commit; would have failed if added before commit 2.*
6. **`Add typecheck job to CI workflow`**
   Extends `.github/workflows/ci.yml`. *Hygiene: CI surface change, no source change.*

**Done when.**
- `pnpm typecheck` is green locally and in CI.
- The `project-refs.test.ts` test is green.
- Manually editing any production `tsconfig.json` to add a forbidden reference, then running `pnpm test`, fails the assertion test. (Verified during implementation, then reverted.)

---

## Phase 3 — ESLint, Prettier, and dependency-direction enforcement (Layer 1)

**Behavior delivered.** ESLint flat config is wired across the workspace with `eslint-plugin-boundaries` enforcing the package dependency graph and Prettier integrated as a lint rule. `pnpm lint` is green on the existing source. A test asserts that a forbidden internal import in a fixture file produces the boundary-rule violation. CI gains a `lint` job. Format-on-save in VS Code (already wired in Phase 1) now actually formats — a `.prettierrc` exists.

**Test cases.**

1. **Forbidden cross-package import is reported by ESLint** — `packages/testing/src/lint-rule.test.ts` uses the ESLint Node API to lint a string of TypeScript source representing a renderer file that imports from `@symnav/backend-typescript`. Asserts the result contains exactly one violation with rule id `boundaries/element-types`.
   - Level: unit.
   - Fixture/harness: programmatic ESLint instance loaded with the workspace config; no on-disk fixture file required.
2. **Prettier rule fires on unformatted code** — same test file: lint a deliberately mis-indented snippet, assert one Prettier-rule violation surfaces.
   - Level: unit.
   - Fixture/harness: same as above.
3. **Test-file import of `@symnav/testing` is allowed** — same test file: lint a snippet representing `packages/renderer/src/foo.test.ts` that imports from `@symnav/testing`, assert no violations.
   - Level: unit.

These three together cover the load-bearing rule wiring: forbidden internal edges fire, formatting fires, the test-file exemption works.

**Components.**

- `eslint.config.js` (root, flat config): single file, configures `@typescript-eslint/parser`, the `boundaries` plugin, and the `prettier` plugin. Defines:
  - **Element types** (one per package), via `boundaries/elements`:
    ```js
    {
      type: "core",      pattern: "packages/core/**",
      type: "renderer",  pattern: "packages/renderer/**",
      type: "backend",   pattern: "packages/backend-typescript/**",
      type: "cli",       pattern: "apps/cli/**",
      type: "testing",   pattern: "packages/testing/**"
    }
    ```
  - **Allowed dependencies**, via `boundaries/element-types`:
    ```
    core      → (nothing internal)
    renderer  → core
    backend   → core
    cli       → core, renderer, backend
    testing   → core
    ```
  - **Test-file overlay**: for files matching `**/*.test.ts` and `**/test/**`, `@symnav/testing` is added to the allowed list for every element type.
  - `prettier/prettier` rule on, `eslint-config-prettier` extended last to disable conflicting stylistic rules.
- `.prettierrc`:
  ```jsonc
  {
    "semi": true,
    "singleQuote": false,
    "trailingComma": "all",
    "printWidth": 100,
    "useTabs": false,
    "tabWidth": 2
  }
  ```
- `.prettierignore`: at minimum `dist/`, `node_modules/`, `coverage/`, `*.tsbuildinfo`, `pnpm-lock.yaml`.
- Root `package.json`: gains `"lint": "eslint ."` script. `devDependencies` gains: `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-boundaries`, `eslint-plugin-prettier`, `eslint-config-prettier`, `prettier`.
- Per-package `package.json`: gains `"lint": "eslint src"` (delegated; root `lint` script is the entry point in CI).
- New test file `packages/testing/src/lint-rule.test.ts`: imports the workspace ESLint config, instantiates `ESLint`, runs `lintText` on three snippets, asserts violations.
- `packages/testing/src/index.ts`: exports `loadWorkspaceEslintConfig()` returning the resolved config object — used by the test to avoid duplicating config-loading logic.
  Signature:
  ```ts
  export function loadWorkspaceEslintConfig(): Promise<unknown>;
  ```
- CI: extend `.github/workflows/ci.yml` to add a `lint` job parallel to `test` and `typecheck`.

**Commit plan.**

1. **`Add Prettier config and ignore file`**
   Adds `.prettierrc` and `.prettierignore`. *Hygiene: declarative config, no consumers yet.*
2. **`Add ESLint flat config with boundaries and prettier plugins`**
   Adds `eslint.config.js`, installs ESLint dev dependencies, adds `lint` scripts to root and per-package `package.json`. Running `pnpm lint` on the existing tree should already be green. *Hygiene: introduces the rule surface; existing source is already conformant.*
3. **`Add loadWorkspaceEslintConfig helper to @symnav/testing`**
   Adds the helper and exports it from `packages/testing/src/index.ts`. *Hygiene: type/helper introduced without callsites.*
4. **`Test: assert ESLint reports forbidden internal imports and formatting violations`**
   Adds `packages/testing/src/lint-rule.test.ts`, exercising the helper introduced in commit 3. Three assertions cover the boundary rule, the prettier rule, and the test-file exemption. *Hygiene: test commit; depends on commit 3's helper, validates commit 2's config.*
5. **`Add lint job to CI workflow`**
   Extends `.github/workflows/ci.yml`. *Hygiene: CI surface change, no source change.*

**Done when.**
- `pnpm lint` is green.
- The new `lint-rule.test.ts` is green.
- A push that adds `import "@symnav/backend-typescript"` to `packages/renderer/src/index.ts` fails the `lint` job in CI. (Verified during implementation, then reverted.)

---

## Phase 4 — `@symnav/testing` fixture loader and trivial fixture

**Behavior delivered.** `@symnav/testing` exports a `fixturePath(name)` helper that resolves a fixture name to an absolute on-disk path. The `trivial-project` fixture exists under `packages/testing/fixtures/`. A unit test asserts the helper returns a path to an existing directory containing the expected files. This is the API every later stage's tests use to mount fixture projects.

**Test cases.**

1. **`fixturePath("trivial-project")` resolves to an existing directory** — `packages/testing/src/fixtures.test.ts`:
   - Asserts the returned path is absolute.
   - Asserts the directory exists.
   - Asserts `package.json`, `tsconfig.json`, and `src/index.ts` exist inside it.
   - Level: unit.
   - Fixture/harness: the trivial-project fixture itself.
2. **`fixturePath` throws a clear error for an unknown fixture name** — same test file:
   - Calls `fixturePath("does-not-exist")`, asserts it throws an error whose message names the missing fixture.
   - Level: unit.

**Components.**

- `packages/testing/fixtures/trivial-project/`:
  - `package.json`:
    ```jsonc
    { "name": "trivial-project", "version": "0.0.0", "private": true, "type": "module" }
    ```
  - `tsconfig.json`:
    ```jsonc
    {
      "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true
      },
      "include": ["src"]
    }
    ```
  - `src/index.ts`:
    ```ts
    export function greet(name: string): string {
      return `hello, ${name}`;
    }
    ```
- `packages/testing/src/fixtures.ts` — the loader.
  ```ts
  export function fixturePath(name: string): string;
  ```
  Behavior described in prose: resolves to `<repo-root>/packages/testing/fixtures/<name>`, computed relative to the source file's location (so it works regardless of `cwd`); throws `Error` with a message including `name` if the directory does not exist.
- `packages/testing/src/index.ts`: re-exports `fixturePath` from `./fixtures` (in addition to the existing `loadWorkspaceEslintConfig`).
- `packages/testing/package.json`: confirm `exports` map covers the public surface.
- `packages/testing/fixtures/`: ensure the directory is included in package's `files` list (or excluded from publish — `@symnav/testing` is private, so this is moot, but the fixture directory must not be excluded by `.npmignore`-style rules from local resolution).
- ESLint flat config: add an `ignores` entry for `packages/testing/fixtures/**` so fixture project sources don't get linted by the workspace's TypeScript rules (they're consumed by tests as data, not built by us).
- `tsconfig.json` `exclude` in `packages/testing`: exclude `fixtures/**` from compilation.

**Commit plan.**

1. **`Add trivial-project fixture under packages/testing/fixtures`**
   Adds the three files of the fixture. Updates `packages/testing/tsconfig.json` `exclude` and `eslint.config.js` `ignores`. *Hygiene: pure addition of test data; no production code touched.*
2. **`Test: fixturePath resolves trivial-project and rejects unknown names`**
   Adds `packages/testing/src/fixtures.test.ts` with both assertions. Test fails because `fixturePath` does not exist yet. *Hygiene: failing test before implementation — TDD red.*
3. **`Add fixturePath helper to @symnav/testing`**
   Adds `packages/testing/src/fixtures.ts` and re-exports from `index.ts`. Test from commit 2 turns green. *Hygiene: minimum implementation to satisfy the test — TDD green.*

**Done when.**
- `pnpm test` is green; the new `fixtures.test.ts` runs in `@symnav/testing`.
- Calling `fixturePath("trivial-project")` from any package's test resolves correctly.

---

## Phase 5 — `symnav --version` CLI binary, build pipeline, and e2e test

**Behavior delivered.** `apps/cli` builds to `dist/cli.js`, an ESM Node script with `#!/usr/bin/env node` shebang. Its `package.json` declares `"bin": { "symnav": "./dist/cli.js" }`. Running `symnav --version` (or `-v`) prints the version from `apps/cli/package.json` to stdout and exits 0. An e2e test spawns the built binary against the trivial-project fixture's directory and asserts the output. `pnpm build` produces the binary; CI gains a `build` job. `pnpm --filter symnav dev` runs the source via `tsx` for fast iteration.

**Test cases.**

1. **`symnav --version` prints the package version and exits 0** — `apps/cli/test/e2e/version.test.ts`:
   - Resolves the path to the built `apps/cli/dist/cli.js`.
   - Spawns it with `--version` as the only arg, with `cwd` set to `fixturePath("trivial-project")`.
   - Asserts exit code is 0.
   - Asserts stdout is exactly the version string from `apps/cli/package.json` followed by a single newline.
   - Asserts stderr is empty.
   - Level: e2e.
   - Fixture/harness: trivial-project fixture (already exists from Phase 4); a Vitest `globalSetup` hook ensures `apps/cli` is built before any e2e test runs.
2. **`symnav -v` is equivalent to `--version`** — same test file:
   - Same shape as above, with `-v` instead of `--version`.
   - Same assertions.
3. **`symnav` with no args exits non-zero with usage on stderr** — same test file:
   - Spawns the binary with no args.
   - Asserts exit code is non-zero (commander's default for missing command).
   - Asserts stderr contains a usage hint.
   - Level: e2e.

These three lock the CLI's contract for Stage 0: version is queryable, no-args behavior is defined.

**Components.**

- `apps/cli/src/cli.ts` — the entry point. First line is `#!/usr/bin/env node`. Top-level structure:
  ```ts
  #!/usr/bin/env node
  import { Command } from "commander";
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import { dirname, join } from "node:path";

  function readPackageVersion(): string;
  function buildProgram(): Command;
  function main(argv: readonly string[]): void;
  ```
  Behavior described in prose: `readPackageVersion` resolves the colocated `package.json` via `import.meta.url`, parses it, returns `version`. `buildProgram` creates a Commander program with `name("symnav")`, `version(readPackageVersion(), "-v, --version")`, no subcommands yet. `main` calls `program.parse(argv)`. The file ends with `main(process.argv)`.
- `apps/cli/src/index.ts`: replaced — was empty, now re-exports `buildProgram` for testability (so future unit tests can drive Commander without spawning a process). The placeholder `index.test.ts` is updated or removed in this phase.
- `apps/cli/package.json`:
  ```jsonc
  {
    "name": "symnav",
    "version": "0.1.0",   // first non-zero version; bumped at Stage 6 release
    "private": true,
    "type": "module",
    "bin": { "symnav": "./dist/cli.js" },
    "main": "./dist/index.js",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    },
    "files": ["dist"],
    "engines": { "node": ">=20" },
    "scripts": {
      "build": "tsc --build",
      "test": "vitest run",
      "typecheck": "tsc --build --noEmit",
      "lint": "eslint src test",
      "dev": "tsx src/cli.ts"
    },
    "dependencies": {
      "commander": "^12.x",
      "@symnav/core": "workspace:*",
      "@symnav/renderer": "workspace:*",
      "@symnav/backend-typescript": "workspace:*"
    },
    "devDependencies": {
      "tsx": "^4.x"
    }
  }
  ```
  (`@symnav/core`, `@symnav/renderer`, `@symnav/backend-typescript` listed even though no symbols are imported yet — locks the workspace dep edges and matches what Stage 1 will need; ESLint boundary rule already permits these edges.)
- `apps/cli/tsconfig.json`: ensure `"include": ["src/**/*.ts"]`, `"exclude": ["src/**/*.test.ts", "test/**"]`. The shebang is preserved by `tsc` automatically.
- `apps/cli/tsconfig.test.json`: includes `test/**/*.ts`, references `@symnav/testing`.
- `apps/cli/test/e2e/version.test.ts`: the three e2e tests above. Uses `node:child_process` `spawnSync` for hermeticity and `fixturePath` from `@symnav/testing` for the `cwd`.
- `apps/cli/test/e2e/global-setup.ts`: Vitest `globalSetup` that runs `pnpm --filter symnav build` once before the suite. Wired via `vitest.config.ts` in `apps/cli` (a per-package Vitest config that extends the root).
- `apps/cli/vitest.config.ts`: extends root, declares `globalSetup` and broadens the test glob to include `test/**/*.test.ts`.
- CI: extend `.github/workflows/ci.yml` to add a `build` job parallel to `lint`/`typecheck`/`test`. The `test` job is updated to depend on `build` (or to run `pnpm build` itself before `pnpm test`) so the e2e test sees a built binary.
- Remove `apps/cli/src/index.test.ts` (placeholder is superseded by real tests).

**Commit plan.**

1. **`Add commander dependency and CLI dev script (tsx) to apps/cli`**
   Updates `apps/cli/package.json` with `commander`, `tsx`, and the `dev` script. *Hygiene: dependency change only; no source uses commander yet.*
2. **`Test (e2e): symnav --version, -v, and no-args behavior`**
   Adds `apps/cli/test/e2e/version.test.ts`, `apps/cli/test/e2e/global-setup.ts`, and `apps/cli/vitest.config.ts`. Tests fail (no `dist/cli.js` to spawn). *Hygiene: failing test before implementation — TDD red.*
3. **`Implement symnav CLI entry point with commander`**
   Adds `apps/cli/src/cli.ts` with the shebang and Commander wiring. Replaces `apps/cli/src/index.ts` with a re-export of `buildProgram`. Removes placeholder `apps/cli/src/index.test.ts`. *Hygiene: implementation only, no config or scripts touched in this commit.*
4. **`Wire bin entry, build script, and dependency edges for apps/cli`**
   Updates `apps/cli/package.json` `bin`, `files`, `engines`, `scripts.build`, and adds the workspace dependency edges. Updates `apps/cli/tsconfig.json` includes/excludes. *Hygiene: package metadata change to make the binary publishable and buildable; together these turn the failing test green (after `pnpm build`).*
5. **`Add build job to CI workflow and order test job after build`**
   Extends `.github/workflows/ci.yml`. *Hygiene: CI surface change.*

**Done when.**
- `pnpm build` produces `apps/cli/dist/cli.js` with a shebang.
- `pnpm --filter symnav dev -- --version` prints the version (proves the dev path works).
- `pnpm test` is green; the three e2e tests in `apps/cli/test/e2e/version.test.ts` all pass.
- CI's `build` job is green; the `test` job sees the built binary.

---

## Phase 6 — Contributor guide (`AGENTS.md`)

**Behavior delivered.** `AGENTS.md` is expanded into a contributor guide: orientation pointing at the functional spec and stages doc, repo layout, day-to-day commands, test conventions, TDD principle, the existing five project rules, and a closing section restating the dependency-direction rule. `CLAUDE.md` remains symlinked to `AGENTS.md`.

**Test cases.**

This phase is documentation. The acceptance test is human review of the resulting `AGENTS.md` against the structure described below. No automated test is added. (Adding a doc-link-checker would be useful work but is out of scope for Stage 0 — it is a tooling concern, not a foundational one.)

**Components.**

`AGENTS.md` (rewritten in place; `CLAUDE.md` symlink unchanged) with sections in this order:

1. **Orientation** — one paragraph: what symnav is in one sentence; pointer to `plans/000/symnav-functional-spec.md` for product info; pointer to `plans/000/symnav-stages.md` for the implementation roadmap. "Read those for high-level context."
2. **Repo layout** — bulleted list with one line per package (`apps/cli`, `packages/core`, `packages/renderer`, `packages/backend-typescript`, `packages/testing`), each describing the package's single responsibility.
3. **Day-to-day commands** — one-liners for `pnpm install`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm --filter symnav dev`.
4. **Test conventions** — colocated unit tests next to source; integration tests under `<package>/test/integration/`; e2e under `apps/cli/test/e2e/`; fixtures under `packages/testing/fixtures/`; use `fixturePath()` from `@symnav/testing` to resolve them.
5. **TDD** — one paragraph restating the principle: failing test before implementation, every behavior covered.
6. **Project rules** — preserved verbatim from current `AGENTS.md`.
7. **Dependency direction** — closing section: the allowed-edges table and a one-line note on the two-layer enforcement (ESLint boundaries + TS project references).

**Commit plan.**

1. **`Expand AGENTS.md into contributor guide`**
   Single commit rewriting `AGENTS.md` with the seven sections above. *Hygiene: documentation-only commit, isolated from source changes.*

**Done when.**
- A reader can open `AGENTS.md` cold and find: where to read the product spec, what each package does, what commands to run, where tests live, and what the dependency rule is.
- `cat CLAUDE.md` (resolving the symlink) shows the same content.

---

## Out of scope

Items deliberately not in this plan, with the future work that owns each:

- **Any v1 command logic** (`overview`, `resolve`, `def`, `refs`, `context`, `graph`). Owned by Stages 1–5.
- **The language-backend interface beyond mere existence as an empty type.** First real method is introduced in Stage 1 with `overview`.
- **Workspace root detection, `.gitignore`-aware file access.** First needed in Stage 1.
- **Publishing `symnav` to npm.** Owned by Stage 6 (Release Hardening).
- **Performance baseline measurement.** Owned by Stage 6.
- **Cross-platform CI matrix (macOS, Windows).** Deferred until path-handling behavior makes it load-bearing — earliest Stage 1.
- **Multi-Node-version CI matrix.** Deferred until runtime-version-sensitive behavior appears.
- **Publish-readiness tooling** (`changesets`, release workflow, npm OTP handling). Owned by Stage 6.
- **Doc link checker, dead-fixture detector, snapshot diff tooling.** Quality-of-life additions for later, not foundational.
- **A `lint:fix` or `format` standalone script.** Format-on-save plus ESLint's `--fix` cover this; a dedicated script is sugar that can be added when someone wants it.
