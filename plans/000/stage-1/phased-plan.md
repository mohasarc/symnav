# Stage 1 — `overview`: Phased Plan

A phased, TDD-driven implementation of [Stage 1 of the symnav stages plan](../symnav-stages.md): the `symnav overview <file>` command, the IR shape, the renderer's first surface, and the language-backend interface — i.e. the walking skeleton through the full architecture.

## Goal

When this plan is complete:

- `pnpm --filter symnav dev -- overview <file>` (and the built `symnav overview <file>`) prints the symbol structure of a TypeScript file: hierarchy, signatures, line ranges, matching the [functional spec's `overview` examples](../symnav-functional-spec.md).
- `--json` produces a structured variant whose shape mirrors the in-memory IR.
- Workspace root detection (walk to nearest `.git`), `--cwd` override, `.gitignore` honoring, and the four user-error paths (missing / outside-workspace / ignored / unsupported extension) are all implemented and tested.
- The TypeScript backend is wired through ts-morph using a `FileSystemHost` adapted from `core`'s `FileSystem` port, so the adapter is an in-memory swap away from real disk for tests.
- E2E snapshot tests against a `packages/testing/fixtures/overview-cases/` project gate the stage. Re-running the same query against the same workspace produces byte-identical output (determinism asserted in CI).

The IR (`SymbolDecl`, `FileSymbols`, `LineRange`, `SymbolKind`), the `LanguageBackend` interface, the `Workspace` abstraction, and the renderer's tree-output rules are all locked here. Stages 2–5 extend these contracts; they do not redefine them.

## Context

Stage 0 left the workspace at empty placeholders. Today every package's `src/index.ts` is `export {};` and the only real production code is `apps/cli` with `commander` wiring `--version`. Stage 1 begins to fill them in.

Relevant existing pieces this plan plugs into:

- **`packages/core`** — owns IR types, workspace services, the language-backend interface, the `BackendRouter`, and the typed `BackendError` hierarchy. Knows nothing about command orchestration, ts-morph, or user-voice text.
- **`packages/renderer`** — adds `renderOverviewText` and `renderOverviewJson` against the IR exported by `core`. Owns all signature presentation policy: cap, ellipsis, and (future) styling.
- **`packages/backend-typescript`** — adds `TypeScriptBackend` plus a pure extraction layer over ts-morph. Produces the IR; produces no rendered text. Public surface is `TypeScriptBackend` only.
- **`apps/cli`** — registers the `overview` subcommand on `program.ts`, owns the overview command orchestration (`runOverview`), and owns user-facing error voice (`Cannot answer: …`).
- **`packages/testing`** — currently exports `fixturePath`. **No new exports in Stage 1.** Per AGENTS.md ("In-memory or mock helpers live beside the tests that use them — not in `@symnav/testing`"), the in-memory `Workspace`/`FileSystem` helpers and the ts-morph `parseTypeScriptSource` helper live in each consuming package's `test/helpers/`. `@symnav/testing` continues to be reserved for cross-cutting utilities with no upstream package deps. (Phase 2 already established this: `InMemoryWorkspace` lives in `packages/core/test/helpers/`, not in `@symnav/testing`.)
- **`packages/testing/fixtures/`** — currently has `trivial-project/`. Stage 1 adds `overview-cases/`, a self-contained per-scenario fixture project.
- **`apps/cli/test/e2e/version.test.ts`** — establishes the e2e shape (spawn `dist/cli.js` with `spawnSync`, `cwd` set to a fixture). New e2e tests follow that shape.
- **`meta-tests/`** — no changes: this stage adds no new packages and does not touch the dependency-direction graph encoded in `eslint.config.mjs` or root `tsconfig.json`.

The dependency direction is locked by Stage 0 and remains:
`@symnav/core` → ∅; `@symnav/renderer` → core; `@symnav/backend-typescript` → core; `apps/cli` → core, renderer, backend-typescript; `@symnav/testing` → ∅ (test files anywhere may import testing).

External runtime dependencies introduced in this stage:

- **`ts-morph`** in `packages/backend-typescript` — the only place ts-morph appears.
- **`ignore`** in `packages/core` — the npm `ignore` package, the standard `.gitignore` matcher used by `eslint`/`prettier`/etc.

The error voice for user-facing failures is the spec's `Cannot answer: <reason>.` form, with a trailing period (matching the two existing examples in the functional spec at lines 47 and 67).

---

## Phase 1 — IR types and symbol-path helper in `@symnav/core`

**Behavior delivered.** `@symnav/core` exports the locked Stage 1 IR (`SymbolKind`, `LineRange`, `SymbolDecl`, `FileSymbols`) and a `buildSymbolPath` helper. Hand-built IR values can be passed through the helper to produce the spec's `::`-joined symbol paths. No backend or renderer consumes them yet; this phase delivers the shape that everything downstream depends on.

**Test cases.**

1. **`buildSymbolPath` returns the local name for a top-level decl** — given a leaf `SymbolDecl` with no ancestors, returns its `name`. Level: unit. File: `packages/core/src/symbol-path.test.ts`. Fixture: hand-built IR literals.
2. **`buildSymbolPath` joins ancestor names with `::`** — given an ancestor chain `[class CheckoutService, method processPayment]`, returns `"CheckoutService::processPayment"`. Level: unit.
3. **`buildSymbolPath` handles three-deep nesting** — namespace → class → method renders as `Outer::Inner::method`. Level: unit.
4. **IR types are exported from package root** — `packages/core/src/index.test.ts` imports `SymbolKind`, `LineRange`, `SymbolDecl`, `FileSymbols`, `buildSymbolPath` from `./index.js` and the test file type-checks. Level: unit (compile-time + assertion that `buildSymbolPath` is a function).

The Stage 0 placeholder test (`expect(mod).toBeDefined()`) is replaced by the import-and-use test in case 4.

**Components.**

```ts
// packages/core/src/ir.ts
export type SymbolKind =
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "namespace"
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "property"
  | "variable"
  | "default-export"
  | "index-signature"
  | "call-signature"
  | "construct-signature";

export interface LineRange {
  readonly startLine: number; // 1-based, inclusive
  readonly endLine: number;   // 1-based, inclusive; equals startLine for single-line decls
}

export interface SymbolDecl {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly range: LineRange;
  readonly signature: string;
  readonly children: readonly SymbolDecl[];
}

export interface FileSymbols {
  readonly filePath: string; // workspace-relative, POSIX separators
  readonly symbols: readonly SymbolDecl[]; // top-level entries, source order
}
```

```ts
// packages/core/src/symbol-path.ts
import type { SymbolDecl } from "./ir.js";

/**
 * Compose a symbol path from an ancestor chain plus a leaf decl.
 * `ancestors` is ordered outer-to-inner (file's top-level first).
 * Result: ancestor names + leaf name, joined by "::".
 */
export function buildSymbolPath(
  ancestors: readonly SymbolDecl[],
  decl: SymbolDecl,
): string;
```

```ts
// packages/core/src/index.ts (replaces export {})
export type { SymbolKind, LineRange, SymbolDecl, FileSymbols } from "./ir.js";
export { buildSymbolPath } from "./symbol-path.js";
```

**Commit plan.**

1. **`Add IR types in @symnav/core: SymbolKind, LineRange, SymbolDecl, FileSymbols`** — adds `packages/core/src/ir.ts`. *Hygiene: type-only, no callsites yet.*
2. **`Test (unit): buildSymbolPath joins ancestor chain with ::`** — adds `packages/core/src/symbol-path.test.ts` with the three behavior tests. Test fails because `symbol-path.ts` doesn't exist yet. *Hygiene: red test alone.*
3. **`Implement buildSymbolPath`** — adds `packages/core/src/symbol-path.ts`. Tests from commit 2 turn green. *Hygiene: implementation matching the failing test.*
4. **`Re-export IR and buildSymbolPath from @symnav/core entry`** — replaces `packages/core/src/index.ts`'s `export {}` with the public surface; replaces the placeholder `index.test.ts` with the import-and-use test (case 4). *Hygiene: re-exports + retire placeholder in one commit; surface change only.*

**Done when.** `pnpm --filter @symnav/core test` is green with four real tests. `pnpm typecheck` and `pnpm lint` are green. The new exports are visible in `packages/core/dist/index.d.ts` after a build.

---

## Phase 2 — `Workspace`, `FileSystem` port, and ignore matcher

**Behavior delivered.** `@symnav/core` exports a `Workspace` abstraction with a `FileSystem` port underneath. `createWorkspace({ startDir, fs })` walks up from `startDir` to find the nearest `.git` and returns a `Workspace` whose `root` is that directory. `Workspace.isIgnored(relPath)` aggregates every `.gitignore` in the workspace and matches per `gitignore(5)` semantics, with `.git/` always implicitly ignored. `@symnav/testing` exports `inMemoryWorkspace({ files, startDir })` so any package's tests can build a `Workspace` against an in-memory filesystem.

This is the substrate every later phase depends on — the only place that knows how to talk to disk for general workspace access.

**Test cases.**

In `packages/core/test/integration/workspace.test.ts`, all driven by `inMemoryWorkspace`:

1. **Root detection finds nearest `.git` ancestor** — files include `.git/HEAD`, `pkg/sub/x.ts`; `startDir = "/repo/pkg/sub"`. `workspace.root` equals `/repo`. Level: integration.
2. **Root detection treats `.git` file (submodule layout) the same as directory** — `.git` is a regular file rather than a dir; root still resolves. Level: integration.
3. **Root detection fails when no `.git` is found** — only ordinary files; `createWorkspace` rejects with a typed `NotInWorkspaceError`. Level: integration.
4. **`toRelative` and `toAbsolute` round-trip via POSIX paths** — given an absolute path under root, `toRelative` returns POSIX-separated relative; `toAbsolute(rel)` returns the original. Level: integration.
5. **`isInWorkspace` returns false for paths above root and for sibling-of-root paths** — `/repo-other/x.ts` and `/repo/../other.ts` both rejected. Level: integration.
6. **`isIgnored` honors a single root `.gitignore`** — root has `.gitignore` listing `dist/`; `isIgnored("dist/x.js")` is true; `isIgnored("src/x.ts")` is false. Level: integration.
7. **`isIgnored` aggregates subdirectory `.gitignore`s** — root `.gitignore` has nothing for `temp.ts`; `pkg/.gitignore` has `temp.ts`; `isIgnored("pkg/temp.ts")` true, `isIgnored("temp.ts")` false. Level: integration.
8. **`isIgnored` honors negation** — `.gitignore` has `dist/\n!dist/keep.js`; `isIgnored("dist/keep.js")` false; `isIgnored("dist/other.js")` true. Level: integration.
9. **`isIgnored` always rejects `.git/` and any path under it** — even with no `.gitignore`. Level: integration.
10. **No `.gitignore` files → no ignore rules** — empty repo with only `.git/HEAD`; `isIgnored` returns false for everything except `.git/...`. Level: integration.
11. **`fs.readFile` reads files placed in the in-memory map** — round-trip a UTF-8 string. Level: integration.

In `packages/testing/src/in-memory-workspace.test.ts`:

12. **`inMemoryWorkspace` rejects calls with no `.git` entry in the file map** — surfaces the `NotInWorkspaceError` from `createWorkspace` rather than a bespoke error. Level: unit.

**Components.**

```ts
// packages/core/src/file-system.ts
export interface WorkspaceFileSystem {
  readFile(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  /** Synchronous existence check; used during workspace construction (root walk). */
  existsSync(absPath: string): boolean;
  /** Synchronous read; used during workspace construction (.gitignore aggregation). */
  readFileSync(absPath: string): string;
  /** Synchronous directory listing for .gitignore discovery. */
  listDirSync(absPath: string): readonly string[];
  /** Whether the path is a directory. */
  isDirectorySync(absPath: string): boolean;
}

export function nodeFileSystem(): WorkspaceFileSystem;
```

```ts
// packages/core/src/workspace.ts
import type { WorkspaceFileSystem } from "./file-system.js";

export interface Workspace {
  readonly root: string;            // absolute, normalized, POSIX or platform-native
  readonly fs: WorkspaceFileSystem;
  /** Convert an absolute path under root to a workspace-relative POSIX path. */
  toRelative(absPath: string): string;
  /** Convert a workspace-relative POSIX path to an absolute platform path. */
  toAbsolute(relPath: string): string;
  /** Whether the given absolute path lies under the workspace root. */
  isInWorkspace(absPath: string): boolean;
  /** .gitignore-aware ignore check for a workspace-relative POSIX path. */
  isIgnored(relPath: string): boolean;
}

export function createWorkspace(opts: {
  startDir: string;
  fs: WorkspaceFileSystem;
}): Promise<Workspace>;
```

```ts
// packages/core/src/errors.ts (introduced here; expanded in Phase 3)
export class NotInWorkspaceError extends Error {
  readonly startDir: string;
  constructor(startDir: string);
}
```

```ts
// packages/testing/src/in-memory-workspace.ts
import type { Workspace, WorkspaceFileSystem } from "@symnav/core";

export function inMemoryFileSystem(files: Record<string, string>): WorkspaceFileSystem;

/**
 * Build a Workspace whose underlying FileSystem is in-memory.
 * `files` keys are absolute POSIX paths; values are file contents.
 * `.git/HEAD` (or `.git` as a regular file entry) must be present so
 * `createWorkspace` can find a root.
 *
 * `startDir` defaults to the lexicographically smallest directory under
 * the inferred root, so tests can omit it for simple cases.
 */
export function inMemoryWorkspace(args: {
  files: Record<string, string>;
  startDir?: string;
}): Promise<Workspace>;
```

`packages/testing/src/index.ts` adds `export { inMemoryWorkspace, inMemoryFileSystem } from "./in-memory-workspace.js";`.

`packages/core/src/index.ts` adds:
```ts
export type { Workspace, WorkspaceFileSystem } from "./workspace.js";
export { createWorkspace, nodeFileSystem } from "./workspace.js";
export { NotInWorkspaceError } from "./errors.js";
```

**Algorithm notes (prose, not implementation).**

- **Root walk.** Start at `startDir`, normalize, repeatedly check `<dir>/.git` via `existsSync`. Stop on first hit. Traverse upward by stripping the last segment until at filesystem root. If the loop terminates without finding `.git`, throw `NotInWorkspaceError`.
- **`.gitignore` aggregation.** At workspace construction, walk the directory tree below `root`, collect every file named `.gitignore`, and feed them to the `ignore` package as one combined matcher with per-file scoping (the `ignore` package supports this via per-file `add` calls; the public method takes paths relative to root). Skip walking into `.git/` and into directories already matched as ignored — the standard git behavior. Ignore-state is computed once and cached on the `Workspace` instance.
- **`isInWorkspace`.** Resolve to a normalized absolute path; check that it begins with `root` and the next char is the path separator (or the path equals root). Reject paths that resolve outside via `..`.

**Dependency:** `ignore` added to `packages/core/package.json` `dependencies`.

**Commit plan.**

1. **`Add ignore dependency to @symnav/core`** — updates `packages/core/package.json` and `pnpm-lock.yaml`. *Hygiene: dependency addition alone, no consumers.*
2. **`Add WorkspaceFileSystem port and node implementation`** — adds `packages/core/src/file-system.ts` with the interface and `nodeFileSystem()`. Re-exported from `index.ts`. *Hygiene: type + factory together; no other code depends on it yet.*
3. **`Test (integration): Workspace root detection and path helpers`** — adds `packages/core/test/integration/workspace.test.ts` covering cases 1–5 against `inMemoryWorkspace`, plus `packages/testing/src/in-memory-workspace.ts` (just enough to satisfy compile — a stub that throws). The Workspace tests fail; the `inMemoryWorkspace` test (case 12) passes. *Hygiene: tests + scaffolding harness; no Workspace impl yet.*
4. **`Add NotInWorkspaceError and Workspace interface`** — adds `packages/core/src/errors.ts` and `packages/core/src/workspace.ts` (interface + `createWorkspace` signature with not-implemented body). Tests still fail. *Hygiene: types + signatures alone.*
5. **`Implement createWorkspace root walk`** — fills `createWorkspace` to satisfy cases 1–5. Cases 6–10 still fail (ignore not yet wired). *Hygiene: smallest impl that turns root-detection tests green.*
6. **`Test (integration): Workspace.isIgnored aggregates .gitignore files`** — adds cases 6–10 to the test file. Tests fail. *Hygiene: tests for the next slice of behavior.*
7. **`Implement Workspace.isIgnored via aggregated .gitignore matcher`** — adds the gitignore-aggregation logic, wires `ignore` package. Tests turn green. *Hygiene: feature implementation matching the red tests.*
8. **`Implement inMemoryWorkspace and inMemoryFileSystem in @symnav/testing`** — replaces the stub from commit 3 with a real in-memory FS that satisfies the `WorkspaceFileSystem` shape; integration tests continue to pass. *Hygiene: pure replacement; the contract was already exercised.*
9. **`Re-export Workspace surface from @symnav/core and @symnav/testing`** — adds the `index.ts` re-exports. *Hygiene: surface only.*

**Done when.** All twelve test cases pass. `pnpm typecheck` and `pnpm lint` are green. `inMemoryWorkspace` is consumable from any test file in any package.

---

## Phase 3 — `LanguageBackend` interface, `BackendError` hierarchy, and `BackendRouter`

**Behavior delivered.** `@symnav/core` exports the `LanguageBackend` interface, the user-facing error hierarchy (`FileNotFoundError`, `OutsideWorkspaceError`, `IgnoredFileError`, `UnsupportedFileError`), and a tiny `BackendRouter` that selects the first backend whose `accepts(filePath)` returns true. No backend implementation exists yet; the router is exercised by a fake backend in tests.

**Test cases.**

In `packages/core/src/backend-router.test.ts`:

1. **Router returns the first acceptor** — with two fake backends accepting different extensions, `find("foo.ts")` returns the TS-extension acceptor. Level: unit.
2. **Router returns `undefined` when no backend accepts** — Level: unit.
3. **Router preserves registration order on tie** — both fakes accept; first wins. Level: unit.

In `packages/core/src/errors.test.ts`:

4. **Each error subclass is an `instanceof BackendError` and `Error`** — covers `FileNotFoundError`, `OutsideWorkspaceError`, `IgnoredFileError`, `UnsupportedFileError`. Level: unit.
5. **Each error carries the displayed path** — the constructor stores a `displayedPath` accessible on the instance. Level: unit.

**Components.**

```ts
// packages/core/src/backend.ts
import type { FileSymbols } from "./ir.js";

export interface LanguageBackend {
  /** Whether this backend can produce IR for the given workspace-relative path. */
  accepts(filePath: string): boolean;
  /**
   * Produce the file's symbol IR. Caller guarantees the path is in-workspace
   * and not ignored. Throws BackendError on failure.
   */
  fileSymbols(filePath: string): Promise<FileSymbols>;
}

export class BackendRouter {
  constructor(backends: readonly LanguageBackend[]);
  find(filePath: string): LanguageBackend | undefined;
}
```

```ts
// packages/core/src/errors.ts (extended from Phase 2)
export class NotInWorkspaceError extends Error { /* unchanged */ }

export class BackendError extends Error {
  readonly displayedPath: string;
  constructor(message: string, displayedPath: string);
}

export class FileNotFoundError extends BackendError {
  constructor(displayedPath: string);
}

export class OutsideWorkspaceError extends BackendError {
  readonly workspaceRoot: string;
  constructor(displayedPath: string, workspaceRoot: string);
}

export class IgnoredFileError extends BackendError {
  constructor(displayedPath: string);
}

export class UnsupportedFileError extends BackendError {
  readonly extension: string;
  constructor(displayedPath: string, extension: string);
}
```

`packages/core/src/index.ts` adds:
```ts
export type { LanguageBackend } from "./backend.js";
export { BackendRouter } from "./backend.js";
export {
  BackendError,
  FileNotFoundError,
  OutsideWorkspaceError,
  IgnoredFileError,
  UnsupportedFileError,
} from "./errors.js";
```

**Commit plan.**

1. **`Test (unit): BackendError subclasses carry typed metadata`** — adds `packages/core/src/errors.test.ts` covering cases 4–5. Tests fail because the subclasses don't exist. *Hygiene: red tests.*
2. **`Add BackendError hierarchy in @symnav/core`** — extends `errors.ts` with the four backend errors. Tests turn green. *Hygiene: types matching failing test.*
3. **`Test (unit): BackendRouter selects first acceptor`** — adds `packages/core/src/backend-router.test.ts` covering cases 1–3. Tests fail because `BackendRouter` doesn't exist. *Hygiene: red test.*
4. **`Add LanguageBackend interface and BackendRouter`** — adds `packages/core/src/backend.ts`. Tests green. *Hygiene: contract + minimal router; no backend implementations yet.*
5. **`Re-export backend surface from @symnav/core entry`** — extends `index.ts`. *Hygiene: surface only.*

**Done when.** Eight new tests pass. The contract for any future backend (TS, Python, Go) is locked: implement `accepts` + `fileSymbols`, throw the typed errors, register with the router. `pnpm typecheck` / `pnpm lint` green.

---

## Phase 4 — IR signature semantics and `BackendError` data revisions

**Behavior delivered.** Two `@symnav/core` contracts shipped earlier are revised before any backend, renderer, or CLI consumes them, so presentation policy stops leaking into the wrong package. No new behavior — these are seam corrections.

1. **`SymbolDecl.signature: string` → `SymbolDecl.signatureSource: string`.** The IR no longer carries pre-rendered display text. Backends produce the raw source-text excerpt of the signature span (uncapped, no ellipsis). The renderer owns truncation, ellipsis, and any future width/styling policy.
2. **`BackendError` subclasses lose `displayedPath` and stop carrying user-facing strings in `Error.message`.** Subclasses become pure type-discrimination markers. `Error.message` becomes opaque developer text — useful in stack traces, never quoted to users. The CLI builds `Cannot answer: <reason>.` lines from the subclass type plus context the CLI already has (`inputPath`, `workspace.root`).

After this phase, `@symnav/core` knows nothing about how errors or signatures are rendered.

**Test cases.**

In `packages/core/src/intermediate-representation/symbol-decl.test.ts` (or extending the Phase 1 test file):

1. **`SymbolDecl.signatureSource` round-trips a raw source-text string** — type-level + a hand-built IR literal demonstrates the field is the raw excerpt (no truncation applied). Level: unit.

In `packages/core/src/backend/errors.test.ts` (extending the Phase 3 file):

2. **Each `BackendError` subclass is `instanceof BackendError` and `Error`** — unchanged. Level: unit.
3. **No subclass exposes a `displayedPath` field** — explicit negative assertion locks the seam. Level: unit.
4. **No subclass exposes a `message` derived from a user-readable template** — `Error.message` is short, opaque, and never templated with caller data. Asserted by checking each subclass's `message` is a fixed token (e.g. `"file-not-found"`), not `"File not found: <path>"`. Level: unit.

**Components.**

```ts
// packages/core/src/intermediate-representation/types.ts (revised)
export interface SymbolDecl {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly range: LineRange;
  readonly signatureSource: string;
  readonly children: readonly SymbolDecl[];
}
```

```ts
// packages/core/src/backend/errors.ts (revised — type-only subclasses)
export class BackendError extends Error {}

export class FileNotFoundError extends BackendError {
  constructor() { super("file-not-found"); this.name = "FileNotFoundError"; }
}
export class IgnoredFileError extends BackendError {
  constructor() { super("ignored-file"); this.name = "IgnoredFileError"; }
}
export class OutsideWorkspaceError extends BackendError {
  constructor() { super("outside-workspace"); this.name = "OutsideWorkspaceError"; }
}
export class UnsupportedFileError extends BackendError {
  constructor() { super("unsupported-file"); this.name = "UnsupportedFileError"; }
}
```

The CLI in Phase 9 catches each subclass and constructs the full user-facing line from its own callsite context (the original `inputPath`, the `workspace.root`, and `path.extname(inputPath)` for the unsupported case).

**Commit plan.**

1. **`Test (unit): SymbolDecl carries signatureSource as raw source text`** — adds case 1. Fails. *Hygiene: red test.*
2. **`Rename SymbolDecl.signature -> signatureSource`** — updates `intermediate-representation/types.ts` and any internal callsite. Tests green. *Hygiene: rename + tests in one commit; renames are mechanical.*
3. **`Test (unit): BackendError subclasses are type-only with no presentation fields`** — extends `errors.test.ts` with cases 3–4. Fails. *Hygiene: red test.*
4. **`Trim BackendError hierarchy: drop displayedPath, drop user-facing message strings`** — simplifies subclass constructors. Tests green. *Hygiene: contract revision.*

**Done when.** Four test cases pass. `pnpm typecheck` / `pnpm lint` green. `@symnav/core` carries no rendering and no user-voice text.

---

## Phase 5 — TypeScript backend pure layer

**Behavior delivered.** `packages/backend-typescript` exports `extractFileSymbols` (package-internal — not on the public surface), the integrator that turns a parsed ts-morph `SourceFile` into the `FileSymbols` IR. Behind it sit a small set of single-purpose helpers (`nodeKind`, `nodeName`, `nodeRange`, `extractSignatureSource`, `extractChildren`, `extractTopLevel`). The whole layer is pure — no disk, no workspace, **no rendering** (no truncation, no ellipsis) — and is exercised by parsing source strings inline through a `parseTypeScriptSource` test helper colocated in `packages/backend-typescript/test/helpers/`. The adapter that owns disk IO comes in Phase 6.

**File layout.** Following the one-thing-per-file convention from Phases 1–3, the pure layer is grouped under `packages/backend-typescript/src/extract/`, one symbol per file:

```
backend-typescript/
  src/
    extract/
      extract-file-symbols.ts
      extract-top-level.ts
      extract-children.ts
      node-kind.ts
      node-name.ts
      node-range.ts
      extract-signature-source.ts
    index.ts
  test/
    helpers/
      parse-typescript-source.ts
      parse-typescript-source.test.ts
```

There is **no `signature-cap.ts` here** — cap and ellipsis policy live in `@symnav/renderer` (Phase 7). `extract-signature-source.ts` returns the raw source-text excerpt of the signature span, untruncated. These helpers stay as free functions because they are stateless leaf utilities, matching `buildSymbolPath`. `parseTypeScriptSource` is **not** added to `@symnav/testing` — per AGENTS.md, in-memory/mock helpers live beside the tests that use them. Phase 6's adapter tests get their own fresh helpers rather than reaching across packages.

**Test cases.**

In `packages/backend-typescript/test/helpers/parse-typescript-source.test.ts`:

1. **`parseTypeScriptSource` returns a ts-morph `SourceFile` whose text round-trips** — Level: unit.

In `packages/backend-typescript/src/extract/node-kind.test.ts`:

2. **`nodeKind` classifier covers each Stage 1 `SymbolKind`** — one focused case per declaration form (function, async function, generator function, class, interface, type alias, enum, namespace, method, constructor, getter, setter, property, variable, default-export expression, index signature, call signature, construct signature). Returns `null` for unsupported nodes (re-exports, bare imports). Level: unit.

In `packages/backend-typescript/src/extract/extract-signature-source.test.ts`:

3. **Function signature span is the source text up to the body brace, no trailing `;`** — input `export function greet(name: string): string { return name; }` → `export function greet(name: string): string`. Async, generator, generic, and overloaded variants asserted as separate cases. Output is **raw source**, never truncated. Level: unit.
4. **Class / interface / enum / namespace signature span ends at the opening `{`** — Level: unit.
5. **Type alias signature span runs to the terminating `;` and is returned in full, however long** — explicitly asserts no truncation; cap/ellipsis is the renderer's concern. Level: unit.
6. **Variable signature span is `const|let|var <name>` plus annotation if present, plus initializer if no annotation, in full** — Level: unit.
7. **Default export signature span is the expression text** — Level: unit.

In `packages/backend-typescript/src/extract/extract-file-symbols.test.ts`:

8. **Empty source produces `FileSymbols` with empty `symbols`** — Level: unit.
9. **`filePath` is forwarded verbatim onto the IR** — Level: unit.
10. **Top-level enumeration covers function, class, interface, type alias, enum, namespace, variable, default-export in source order** — asserts each top-level decl's kind and that order is preserved. Level: unit.
11. **A class's children include constructor, method, getter, setter, property, static method, abstract method (on an abstract base)** — Level: unit.
12. **An interface's children include properties, methods, index signature, call signature, construct signature** — Level: unit.
13. **A namespace's children recurse — a nested function inside a namespace appears as a child `function` decl** — Level: unit.
14. **A single `const a = 1, b = 2` statement produces two separate `variable` decls, each with its own range** — Level: unit.
15. **Single-line decls have `startLine === endLine`; multi-line decls span exact source lines** — Level: unit.
16. **Re-exports (`export { foo } from "./x"`) and bare imports (`import "./side"`) produce no decls** — Level: unit.

**Components.**

```ts
// packages/backend-typescript/test/helpers/parse-typescript-source.ts
import type { SourceFile } from "ts-morph";

export function parseTypeScriptSource(source: string, fileName?: string): SourceFile;
```

```ts
// packages/backend-typescript/src/extract/node-kind.ts
import type { Node } from "ts-morph";
import type { SymbolKind } from "@symnav/core";

export function nodeKind(node: Node): SymbolKind | null;
```

```ts
// packages/backend-typescript/src/extract/node-name.ts
import type { Node } from "ts-morph";

export function nodeName(node: Node): string;
```

```ts
// packages/backend-typescript/src/extract/node-range.ts
import type { Node } from "ts-morph";
import type { LineRange } from "@symnav/core";

export function nodeRange(node: Node): LineRange;
```

```ts
// packages/backend-typescript/src/extract/extract-signature-source.ts
import type { Node } from "ts-morph";

export function extractSignatureSource(node: Node): string;
```

```ts
// packages/backend-typescript/src/extract/extract-children.ts
import type { Node } from "ts-morph";
import type { SymbolDecl } from "@symnav/core";

export function extractChildren(parent: Node): readonly SymbolDecl[];
```

```ts
// packages/backend-typescript/src/extract/extract-top-level.ts
import type { SourceFile } from "ts-morph";
import type { SymbolDecl } from "@symnav/core";

export function extractTopLevel(sourceFile: SourceFile): readonly SymbolDecl[];
```

```ts
// packages/backend-typescript/src/extract/extract-file-symbols.ts
import type { SourceFile } from "ts-morph";
import type { FileSymbols } from "@symnav/core";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
}): FileSymbols;
```

`packages/backend-typescript/src/index.ts` re-exports **only** the public surface needed by `apps/cli`. After Phase 5, that surface is empty — `TypeScriptBackend` arrives in Phase 6. `extractFileSymbols` and the smaller helpers stay package-internal; the Phase 6 adapter and any test that compares against them imports them via internal file paths, not via the package entry.

**Algorithm notes (prose, not implementation).**

- **`extractTopLevel`.** Iterate `sourceFile.getStatements()`. Classify each via `nodeKind`; skip nulls. For `VariableStatement`, expand into one decl per declared name. Build `SymbolDecl` from name, range, `signatureSource`, and `extractChildren(node)` (empty for leaves; non-empty for class/interface/namespace).
- **`extractSignatureSource`.** Source-text-driven; **never truncates**. Functions/methods → declaration text up to (but not including) the body brace, dropping any trailing `;`. Class/interface/enum/namespace → declaration text up to the opening `{`. Type aliases → declaration text up to the terminating `;`, in full. Variables → `const|let|var <name>` plus annotation if present, plus initializer if no annotation, in full.
- **`nodeKind`.** Switch over ts-morph `SyntaxKind`s to the `SymbolKind` union. Unhandled kinds return `null` (skipped silently).

**Dependency:** `ts-morph` added to `packages/backend-typescript/package.json` `dependencies`. `@symnav/testing` is **not** modified — `parseTypeScriptSource` lives in this package's test helpers.

**Commit plan.**

1. **`Add ts-morph dependency to @symnav/backend-typescript`** — package.json + lockfile only. *Hygiene: dependency change alone.*
2. **`Test (unit): parseTypeScriptSource round-trips a TS source string`** — adds `test/helpers/parse-typescript-source.test.ts`. Fails. *Hygiene: red test.*
3. **`Add parseTypeScriptSource test helper`** — adds `test/helpers/parse-typescript-source.ts`. Test green. *Hygiene: smallest impl.*
4. **`Test (unit): nodeKind classifier covers Stage 1 SymbolKind vocabulary`** — adds `src/extract/node-kind.test.ts` covering case 2. Fails. *Hygiene: red test.*
5. **`Implement nodeKind classifier`** — adds `src/extract/node-kind.ts`. Tests green. *Hygiene: classifier first.*
6. **`Add nodeName and nodeRange leaf helpers`** — adds `src/extract/node-name.ts` and `src/extract/node-range.ts` together; each is a thin wrapper on ts-morph and is exercised indirectly by the upcoming extract-file-symbols tests. *Hygiene: trivial paired helpers.*
7. **`Test (unit): extractSignatureSource returns raw, untruncated source per declaration form`** — adds `src/extract/extract-signature-source.test.ts` covering cases 3–7. Fails. *Hygiene: red tests.*
8. **`Implement extractSignatureSource`** — adds `src/extract/extract-signature-source.ts`. Tests green. *Hygiene: feature impl, no truncation logic at all.*
9. **`Test (unit): extractFileSymbols produces FileSymbols matching IR shape`** — adds `src/extract/extract-file-symbols.test.ts` covering cases 8–16. Fails. *Hygiene: red tests for the integrating function.*
10. **`Implement extractTopLevel and extractChildren`** — adds the two recursion helpers in their own files. *Hygiene: recursion machinery, kept separate from the integrator below for diff clarity.*
11. **`Implement extractFileSymbols`** — adds `src/extract/extract-file-symbols.ts`. Tests green. **No change to `src/index.ts` in this phase** — `extractFileSymbols` stays package-internal; the public surface remains empty until Phase 6 adds `TypeScriptBackend`. *Hygiene: integrator alone.*

**Done when.** All sixteen test cases pass. `pnpm typecheck` and `pnpm lint` green. The pure layer is fully exercised without a `Workspace` or disk. The package's public surface (`src/index.ts`) is unchanged from Stage 0. `@symnav/testing` is unchanged.

---

## Phase 6 — TypeScript backend adapter (`TypeScriptBackend`)

**Behavior delivered.** `packages/backend-typescript` exports `TypeScriptBackend`, a `LanguageBackend` implementation that drives ts-morph through a `FileSystemHost` adapted from `core`'s `FileSystem` port. `accepts(filePath)` returns true for `.ts`, `.tsx`, `.mts`, `.cts`, and `.d.ts`. `fileSymbols(filePath)` loads the requested file via the workspace's filesystem, hands the resulting `SourceFile` to `extractFileSymbols`, and returns the IR. No tsconfig is loaded; ts-morph runs in single-file mode.

**File layout.** One thing per file, grouped under `packages/backend-typescript/src/typescript-backend/`. The integration tests need their own `InMemoryWorkspace` — per AGENTS.md, that helper is reimplemented in this package's `test/helpers/` rather than shared with `@symnav/core`'s test helpers across package boundaries:

```
backend-typescript/
  src/
    typescript-backend/
      typescript-backend.ts          # class TypeScriptBackend
      typescript-extensions.ts       # TYPESCRIPT_EXTENSIONS, acceptsTypeScriptFile
      workspace-file-system-host.ts  # adapts FileSystem → ts-morph FileSystemHost
      load-source-file.ts            # encapsulates per-call ts-morph Project setup
    index.ts
  test/
    helpers/
      in-memory-file-system.ts       # local copy; no cross-package test imports
      in-memory-workspace.ts         # local copy
    integration/
      typescript-backend.test.ts
```

**Test cases.**

In `packages/backend-typescript/test/integration/typescript-backend.test.ts`, all driven by the local `InMemoryWorkspace`:

1. **`accepts` returns true for `.ts`/`.tsx`/`.mts`/`.cts`/`.d.ts`, false for `.js`/`.json`/`.md`** — `.d.ts` is matched ahead of `.ts`. Level: integration.
2. **`fileSymbols` produces IR matching `extractFileSymbols` over the same source** — given an in-memory workspace with `src/x.ts` containing a known class, the backend returns identical IR. Level: integration.
3. **`fileSymbols` returns `filePath` as the workspace-relative POSIX path** — even when the filesystem stores absolute paths internally. Level: integration.
4. **`fileSymbols` reads the file exclusively through `Workspace.fs`** — wrap the in-memory FS with a counting decorator; assert `readFile` was called for the requested path and that ts-morph never touched the real filesystem. Level: integration.
5. **`fileSymbols` on a nonexistent file throws `FileNotFoundError`** — defense-in-depth; the user-visible flow rejects earlier in `runOverview`. Level: integration.

**Components.**

```ts
// packages/backend-typescript/src/typescript-backend/typescript-extensions.ts
export const TYPESCRIPT_EXTENSIONS = [".d.ts", ".ts", ".tsx", ".mts", ".cts"] as const;

export function acceptsTypeScriptFile(filePath: string): boolean;
```

```ts
// packages/backend-typescript/src/typescript-backend/workspace-file-system-host.ts
import type { FileSystem } from "@symnav/core";
import type { FileSystemHost } from "ts-morph";

export class WorkspaceFileSystemHost implements FileSystemHost {
  constructor(fs: FileSystem);
}
```

The class makes only the methods that ts-morph actually invokes for single-file `addSourceFileAtPath` work; unused methods throw an explicit "not supported in single-file mode" error so a future call site forces a deliberate decision instead of silent disk access. Implementing `FileSystemHost` as a class (rather than a factory returning a literal) keeps the public/private boundary explicit per the AGENTS.md "prefer classes" rule.

```ts
// packages/backend-typescript/src/typescript-backend/load-source-file.ts
import type { SourceFile } from "ts-morph";
import type { FileSystem } from "@symnav/core";

export function loadSourceFile(args: {
  fs: FileSystem;
  absolutePath: string;
}): SourceFile;
```

Encapsulates the per-call `Project` construction (custom `fileSystemHost`, `addSourceFileAtPath`, error mapping) so `TypeScriptBackend` reads as orchestration only.

```ts
// packages/backend-typescript/src/typescript-backend/typescript-backend.ts
import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";

export class TypeScriptBackend implements LanguageBackend {
  constructor(workspace: Workspace);
  accepts(filePath: string): boolean;
  fileSymbols(filePath: string): Promise<FileSymbols>;
}
```

```ts
// packages/backend-typescript/src/index.ts
export { TypeScriptBackend } from "./typescript-backend/typescript-backend.js";
```

`TYPESCRIPT_EXTENSIONS` and `extractFileSymbols` stay package-internal: the router exercises the `accepts(filePath)` method, not the constant; the adapter consumes `extractFileSymbols` via internal import. Keeping the public surface to one class avoids leaking ts-morph types or implementation-detail constants to `apps/cli`.

**Algorithm notes (prose, not implementation).**

- **`acceptsTypeScriptFile`.** Lowercase the basename; check against `TYPESCRIPT_EXTENSIONS` in declared order so `.d.ts` is matched before `.ts`.
- **`TypeScriptBackend.fileSymbols`.** Resolve the workspace-relative path to absolute via `workspace.toAbsolute`. Delegate to `loadSourceFile` for the ts-morph dance. If `loadSourceFile` reports a missing file, throw `FileNotFoundError`. Hand the `SourceFile` to `extractFileSymbols` and return its result. The `Project` is discarded with the call (cold-per-invocation; no caching in Stage 1).

**Commit plan.**

1. **`Add InMemoryFileSystem and InMemoryWorkspace test helpers in @symnav/backend-typescript`** — adds `test/helpers/in-memory-file-system.ts` and `test/helpers/in-memory-workspace.ts`, mirroring the `core` versions. The duplication is deliberate: AGENTS.md prefers loose coupling over cross-package DRY for test scaffolding. *Hygiene: scaffolding alone, no callsites yet.*
2. **`Test (integration): TypeScriptBackend.accepts honors TypeScript extensions`** — adds the integration test file with case 1. Fails (class doesn't exist). *Hygiene: red test.*
3. **`Add typescript-extensions module and TypeScriptBackend with stub fileSymbols`** — adds `typescript-extensions.ts` (constant + `acceptsTypeScriptFile`) and `typescript-backend.ts` whose `accepts` delegates to it; `fileSymbols` throws "not implemented". Case 1 green. *Hygiene: smallest impl for the red test.*
4. **`Add WorkspaceFileSystemHost adapting FileSystem to ts-morph`** — adds `workspace-file-system-host.ts`. *Hygiene: adapter alone, no callsites yet.*
5. **`Add loadSourceFile encapsulating per-call ts-morph Project setup`** — adds `load-source-file.ts` wired to the host above. *Hygiene: helper alone, still no `fileSymbols` consumer.*
6. **`Test (integration): TypeScriptBackend.fileSymbols reads via Workspace.fs and returns IR`** — adds cases 2–5. Fails. *Hygiene: red tests.*
7. **`Implement TypeScriptBackend.fileSymbols on top of loadSourceFile and extractFileSymbols`** — replaces the stub. Tests green. *Hygiene: integrator.*
8. **`Re-export TypeScriptBackend from package entry`** — adds the single public export. *Hygiene: surface only; TYPESCRIPT_EXTENSIONS and extractFileSymbols stay internal.*

**Done when.** Five integration tests pass. The backend reads exclusively through `Workspace.fs` (verified by case 4). `pnpm typecheck` / `pnpm lint` green.

---

## Phase 7 — Overview renderer (text + JSON)

**Behavior delivered.** `packages/renderer` exports `renderOverviewText(file: FileSymbols): string` and `renderOverviewJson(file: FileSymbols): string`. Given any `FileSymbols` IR, the text renderer produces output matching the spec's `overview` shape exactly: header, blank line, top-level entries flat with 3-space-indented signatures, nested entries with `├──`/`└──`/`│   ` Unicode tree characters, `(no symbols)` for empty files, trailing newline. **The text renderer also owns signature presentation policy: cap at `SIGNATURE_CAP_CHARS` and append `SIGNATURE_ELLIPSIS` when the raw `signatureSource` exceeds the cap.** The JSON renderer produces 2-space-indented sorted-key output with `children` always present, **emits `signatureSource` verbatim (uncapped, no ellipsis)**, and ends with a trailing newline.

**File layout.** One thing per file under `packages/renderer/src/overview/`. Free functions are appropriate here — these are stateless transformations.

```
renderer/
  src/
    overview/
      render-overview-text.ts        # renderOverviewText (recursive walk inlined)
      render-overview-json.ts        # renderOverviewJson (sorted-key serializer inlined)
      tree-glyphs.ts                 # TREE_BRANCH, TREE_LAST, TREE_VERTICAL, TREE_SPACE, SIGNATURE_INDENT
      signature-cap.ts               # SIGNATURE_CAP_CHARS, SIGNATURE_ELLIPSIS, capSignature
    index.ts
```

The earlier draft of this phase split out `render-decl-block`, `render-children`, and `stable-stringify` as separate files. Removed: each was a single-caller helper inside one renderer with no independent test coverage — splitting bought file-hopping without **depth**. They're inlined into the integrating renderer files. Re-split only if a second caller appears or the logic grows enough to warrant a name.

`signature-cap.ts` lives **here**, not in `@symnav/backend-typescript`. Cap and ellipsis are presentation policy: the text renderer applies them; the JSON renderer skips them; a future `--no-truncate` or terminal-width flag would also live here. Backends produce raw source text; the renderer decides how it appears.

**Test cases.**

In `packages/renderer/src/overview/render-overview-text.test.ts`, all driven by hand-built `FileSymbols` literals:

1. **Empty file renders `Overview: <filePath>\n\n(no symbols)\n`** — Level: unit.
2. **Single top-level function renders flat with the `SIGNATURE_INDENT` (3 spaces)** — Level: unit. Inline snapshot.
3. **Multiple top-level entries are separated by blank lines** — three top-level decls produce exactly two blank-line separators. Level: unit.
4. **Class with three methods uses `├──`/`└──` and `│   `/`    ` correctly** — last method uses `└──` and `    ` for the signature continuation. Level: unit.
5. **Three-deep nesting (namespace → class → method) indents correctly** — descendants under a closed branch use `    ` instead of `│   ` for the corresponding column. Level: unit.
6. **Single-line range renders as `8`, multi-line as `12-96`** — Level: unit.
7. **Symbol path includes ancestors joined by `::`** — Level: unit.
8. **Output ends with exactly one trailing newline** — asserted on every text-render test via a shared `assertSingleTrailingNewline` helper colocated in the test file. Level: unit.
9. **`signatureSource` shorter than `SIGNATURE_CAP_CHARS` is emitted verbatim** — Level: unit.
10. **`signatureSource` longer than `SIGNATURE_CAP_CHARS` is truncated to the cap and suffixed with `SIGNATURE_ELLIPSIS`** — Level: unit.

In `packages/renderer/src/overview/signature-cap.test.ts`:

11. **`capSignature(source)` returns `source` unchanged when `source.length <= SIGNATURE_CAP_CHARS`** — Level: unit.
12. **`capSignature(source)` returns the first `SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length` chars + `SIGNATURE_ELLIPSIS` otherwise** — exact byte-budget assertion locks the contract. Level: unit.

In `packages/renderer/src/overview/render-overview-json.test.ts`:

13. **JSON output mirrors `FileSymbols` verbatim, with `children` always present** — leaf decls render `"children": []` rather than omitting the key. Level: unit.
14. **JSON output is 2-space-indented with sorted keys and a trailing newline** — Level: unit.
15. **JSON emits `signatureSource` uncapped** — even for sources well above `SIGNATURE_CAP_CHARS`. Explicit assertion that JSON does **not** apply the cap. Level: unit.
16. **JSON renders identical bytes for identical IR across two calls** — determinism. Level: unit.

**Components.**

```ts
// packages/renderer/src/overview/tree-glyphs.ts
export const TREE_BRANCH = "├── ";
export const TREE_LAST = "└── ";
export const TREE_VERTICAL = "│   ";
export const TREE_SPACE = "    ";
export const SIGNATURE_INDENT = "   ";
```

```ts
// packages/renderer/src/overview/signature-cap.ts
export const SIGNATURE_CAP_CHARS = 120;
export const SIGNATURE_ELLIPSIS = "…";

export function capSignature(source: string): string;
```

```ts
// packages/renderer/src/overview/render-overview-text.ts
import type { FileSymbols } from "@symnav/core";

export function renderOverviewText(file: FileSymbols): string;
```

```ts
// packages/renderer/src/overview/render-overview-json.ts
import type { FileSymbols } from "@symnav/core";

export function renderOverviewJson(file: FileSymbols): string;
```

```ts
// packages/renderer/src/index.ts
export { renderOverviewText } from "./overview/render-overview-text.js";
export { renderOverviewJson } from "./overview/render-overview-json.js";
```

`signature-cap.ts` is package-internal — `capSignature` is consumed only by `renderOverviewText`. Tests import it directly.

**Algorithm notes (prose, not implementation).**

- **Text rendering.** Emit header `Overview: <filePath>` plus blank line. Walk top-level `symbols` in order; each top-level decl produces a two-line block (`<range>: <symbol-path>` then `<SIGNATURE_INDENT><capSignature(signatureSource)>`), separated by blank lines. For each top-level decl with non-empty `children`, recurse with tree prefixes — `├── ` for non-last siblings, `└── ` for the last. The signature continuation column is `│   ` for non-last and `    ` for last. The accumulated prefix for grandchildren replaces any `│   ` from a closed parent with `    ` so descendants under a closed branch are not mis-aligned. The recursion lives inline inside `render-overview-text.ts`.
- **Empty file.** `Overview: <filePath>\n\n(no symbols)\n`.
- **JSON rendering.** Build a plain object from the IR, ensuring `children` is always an array (even empty). `signatureSource` is copied verbatim — **no cap applied**. Serialize with `JSON.stringify(value, sortedKeyReplacer, 2)` (the sorted-key replacer lives inline). Append `\n`.

**Commit plan.**

1. **`Add tree-glyph constants in @symnav/renderer`** — adds `src/overview/tree-glyphs.ts`. *Hygiene: constants alone.*
2. **`Test (unit): capSignature applies SIGNATURE_CAP_CHARS + SIGNATURE_ELLIPSIS`** — adds `src/overview/signature-cap.test.ts` with cases 11–12. Fails. *Hygiene: red test.*
3. **`Add capSignature with cap + ellipsis policy`** — adds `src/overview/signature-cap.ts`. Tests green. *Hygiene: pure helper, foundational for the text renderer.*
4. **`Test (unit): renderOverviewText shape — header, empty file, flat top-level, signature cap`** — adds `src/overview/render-overview-text.test.ts` covering cases 1–2 + 8–10 plus the colocated `assertSingleTrailingNewline` helper. Fails. *Hygiene: red tests.*
5. **`Implement renderOverviewText for flat top-level shape with capped signatures`** — adds `src/overview/render-overview-text.ts`; consumes `capSignature` for the signature line. Cases 1–2 + 8–10 green. *Hygiene: smallest impl, recursion deferred.*
6. **`Test (unit): renderOverviewText nested entries with tree glyphs`** — adds cases 3–7. Fails. *Hygiene: red tests.*
7. **`Extend renderOverviewText with the recursive child walk`** — adds the recursion inline; no new file. Tests green. *Hygiene: feature impl.*
8. **`Test (unit): renderOverviewJson mirrors IR with sorted keys, uncapped signatures, stable bytes`** — adds `src/overview/render-overview-json.test.ts` covering cases 13–16. Fails. *Hygiene: red tests.*
9. **`Implement renderOverviewJson with inline sorted-key serialization`** — adds `src/overview/render-overview-json.ts`. Sort-key replacer lives inline inside the file. Tests green. *Hygiene: integrator.*
10. **`Re-export overview renderers from @symnav/renderer entry`** — *Hygiene: surface only.*

**Done when.** Sixteen test cases pass. The renderer is consumable from `apps/cli` in Phase 9. `pnpm typecheck` / `pnpm lint` green.

---

## Phase 8 — Overview command logic in `apps/cli`

**Behavior delivered.** `apps/cli` gains `runOverview(args)`, the async command logic that orchestrates: resolve user-supplied path against `cwd` → check existence → check workspace membership → check ignore → route to a backend → return `FileSymbols`. Each validation failure throws the appropriate `BackendError` from Phase 4. The function is independently testable with a fake backend; no real backend, renderer, or commander wiring is involved.

This phase deliberately keeps `runOverview` **out of `@symnav/core`**. Core's role is "language-agnostic primitives + cross-language backend interface" — orchestration with knowledge of cwd, user inputs, and validation ordering is frontend wiring. The only consumer is the CLI, so it lives in the CLI.

**File layout.** Under `apps/cli/src/commands/overview/`, one file per concern. Test helpers live in `apps/cli/test/helpers/` and `apps/cli/test/integration/...` per AGENTS.md.

```
apps/cli/
  src/
    commands/
      overview/
        run-overview.ts             # public runOverview function (CLI-internal)
        resolve-input-path.ts       # internal: { cwd, inputPath } → absolute path
        validate-overview-target.ts # internal: existence → in-workspace → ignored → routed
  test/
    helpers/
      in-memory-file-system.ts
      in-memory-workspace.ts
    integration/
      commands/
        overview/
          run-overview.test.ts
          fake-language-backend.ts  # local recording test double
```

`runOverview` stays a free function (no shared state across invocations); the validation pipeline lives in its own file because the ordering rule is the load-bearing decision and isolating it keeps the orchestrator readable.

**Test cases.**

In `apps/cli/test/integration/commands/overview/run-overview.test.ts`, driven by the local `InMemoryWorkspace.create` and a local recording `FakeLanguageBackend`:

1. **Happy path: relative input path, workspace member, not ignored, accepted** — returns the fake backend's IR. Level: integration.
2. **Absolute input path returns the same IR** — Level: integration.
3. **Relative path resolves against `cwd`, not workspace root** — `cwd` is a subdirectory; passing `x.ts` resolves to `<cwd>/x.ts`, not `<root>/x.ts`. Level: integration.
4. **Missing file → `FileNotFoundError`** — Level: integration. (No `displayedPath` assertion: the error carries no presentation data; the CLI's catch frame builds user voice from its own `inputPath`.)
5. **Path outside workspace → `OutsideWorkspaceError`** — Level: integration.
6. **Ignored path → `IgnoredFileError`** — Level: integration.
7. **No backend accepts → `UnsupportedFileError`** — Level: integration. (Extension is derived by the CLI via `path.extname(inputPath)`; not carried on the error.)
8. **Validation order: missing > outside > ignored > unsupported** — when several conditions fail simultaneously (e.g. missing file outside workspace), the first applicable error wins. Each pairwise combination asserted separately. Level: integration.
9. **Backend is invoked with the workspace-relative POSIX path** — not absolute, not platform-native; verified via the recording fake. Level: integration.

**Components.**

```ts
// apps/cli/src/commands/overview/run-overview.ts
import type { BackendRouter, FileSymbols, Workspace } from "@symnav/core";

export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
  inputPath: string;
}

export function runOverview(args: RunOverviewArgs): Promise<FileSymbols>;
```

```ts
// apps/cli/src/commands/overview/resolve-input-path.ts
export function resolveInputPath(args: {
  cwd: string;
  inputPath: string;
}): string;
```

```ts
// apps/cli/src/commands/overview/validate-overview-target.ts
import type { BackendRouter, LanguageBackend, Workspace } from "@symnav/core";

export function validateOverviewTarget(args: {
  workspace: Workspace;
  router: BackendRouter;
  absolutePath: string;
}): Promise<{ relativePath: string; backend: LanguageBackend }>;
```

No change to `packages/core/src/index.ts` — `runOverview` is **not** exported from `@symnav/core`. Phase 9's `runOverviewAction` imports it from the sibling file.

**Algorithm notes (prose, not implementation).**

- **`resolveInputPath`.** If `inputPath` is absolute, return it as-is. Otherwise, `path.resolve(cwd, inputPath)`. Returns just the absolute path; the original `inputPath` is kept on the caller's frame for any user-facing display in the catching layer.
- **`validateOverviewTarget`.** Sequence: `fs.exists(absolutePath)` → `workspace.isInWorkspace(absolutePath)` → `workspace.isIgnored(workspace.toRelative(absolutePath))` → `router.find(relativePath)`. The first failing gate throws its error (no presentation data attached — Phase 4's structured errors carry only their type); subsequent gates do not run. Returns `{ relativePath, backend }` on success.
- **`runOverview`.** Compose the two helpers, then delegate to `backend.fileSymbols(relativePath)`.

**Commit plan.**

1. **`Add InMemoryFileSystem and InMemoryWorkspace test helpers in apps/cli`** — adds `test/helpers/`, mirroring Phase 6's rationale (loose coupling over cross-package test imports). *Hygiene: scaffolding alone.*
2. **`Add FakeLanguageBackend local test double`** — adds `test/integration/commands/overview/fake-language-backend.ts`, a recording double colocated with the test that consumes it. *Hygiene: scaffolding alone.*
3. **`Add resolveInputPath helper for runOverview`** — adds `src/commands/overview/resolve-input-path.ts`. *Hygiene: leaf helper alone, covered indirectly by upcoming tests.*
4. **`Test (integration): runOverview happy-path resolves and dispatches to the backend`** — adds `run-overview.test.ts` covering cases 1–3 + 9. Fails. *Hygiene: red.*
5. **`Implement runOverview happy-path with resolveInputPath and direct dispatch`** — adds `src/commands/overview/run-overview.ts`. Cases 1–3 + 9 green; validation cases still fail with raw exceptions. *Hygiene: smallest impl.*
6. **`Test (integration): runOverview validation errors and locked ordering`** — adds cases 4–8. Fails. *Hygiene: red.*
7. **`Add validateOverviewTarget with the locked validation order`** — adds `src/commands/overview/validate-overview-target.ts` and updates `runOverview` to delegate to it. Tests green. *Hygiene: validation pipeline in its own file, integrator updated.*

**Done when.** Nine integration tests pass. `runOverview` is fully testable without ts-morph or a real backend. `@symnav/core`'s public surface is unchanged. `pnpm typecheck` / `pnpm lint` green.

---

## Phase 9 — CLI `overview` subcommand

**Behavior delivered.** `apps/cli/src/program.ts` registers an `overview` subcommand with positional `<file>`, a `--json` flag, and the program-level `--cwd <dir>` option. The CLI builds a `NodeWorkspace`, instantiates `[new TypeScriptBackend(workspace)]` behind a `BackendRouter`, calls `runOverview` (the sibling function from Phase 8), and writes either the text or JSON renderer's output to stdout. `BackendError`s and `NotInWorkspaceError` are caught and printed to stderr in the spec's `Cannot answer: <reason>.` voice with exit code 1. Unexpected errors print to stderr and exit 2.

This phase owns **all** user-facing error voice. `formatUserError` constructs the full `Cannot answer: …` line by switching on the typed error subclass and assembling the sentence from data the CLI already has on the catching frame (`inputPath`, `workspace.root`, `cwd`).

No new runtime dependencies; everything wires existing pieces.

**File layout.** One thing per file. `cli.ts`/`program.ts`/`index.ts` already exist; the helpers from Phase 8 (`in-memory-workspace.ts`, `in-memory-file-system.ts`, `fake-language-backend.ts`) are reused. This phase adds:

```
apps/cli/
  src/
    program.ts                       # extended with context arg + overview registration
    program-context.ts               # ProgramContext interface (stdout/stderr/cwd/exit)
    commands/
      overview/
        register-overview-command.ts # wires the commander subcommand
        run-overview-action.ts       # async action: build workspace → run → render → write
        write-overview-output.ts     # internal: chooses text vs JSON renderer and writes to stdout
    error-output/
      format-user-error.ts           # (err, ctx) → "Cannot answer: …." | null
      format-user-error.test.ts
  test/
    integration/
      commands/
        overview/
          overview-command.test.ts   # in-process program invocation
          fake-program-context.ts    # stdout/stderr buffer streams + exit recorder
```

**Test cases.**

In `apps/cli/src/error-output/format-user-error.test.ts`:

1. **Each `BackendError` subclass formats to its `Cannot answer: <reason>.` line with a trailing period** — given context `{ inputPath, workspaceRoot }`, one case per subclass:
   - `FileNotFoundError` → `Cannot answer: file not found: <inputPath>.`
   - `IgnoredFileError` → `Cannot answer: <inputPath> is ignored by .gitignore.`
   - `OutsideWorkspaceError` → `Cannot answer: <inputPath> is outside the workspace rooted at <workspaceRoot>.`
   - `UnsupportedFileError` → `Cannot answer: cannot read <ext> files (<inputPath>).` (extension derived from `path.extname(inputPath)`)
   Level: unit.
2. **`NotInWorkspaceError` formats to `Cannot answer: not in a git workspace (no .git found in or above <cwd>).`** — given context `{ cwd }`. Level: unit.
3. **An unrelated `Error` returns `null`** — signals "let it propagate to the exit-2 path". Level: unit.

In `apps/cli/test/integration/commands/overview/overview-command.test.ts` — the program is invoked in-process via `buildProgram(...).parseAsync(...)` against the `InMemoryWorkspace` from Phase 8. Stdout, stderr, cwd, and exit are all captured via the injected `ProgramContext`. Subprocess e2e is Phase 10:

4. **`overview <file>` writes text-rendered IR to stdout, exit 0** — Level: integration.
5. **`overview <file> --json` writes JSON to stdout, exit 0** — Level: integration.
6. **`overview` on a missing file writes the file-not-found line to stderr, exit 1** — Level: integration.
7. **`overview` on a path outside the workspace writes the outside-workspace line, exit 1** — Level: integration.
8. **`overview` on an ignored path writes the ignored line, exit 1** — Level: integration.
9. **`overview` on a `.json` file writes the unsupported-extension line citing `.json`, exit 1** — Level: integration.
10. **`overview` with no `.git` in or above the program's cwd writes the no-workspace line, exit 1** — Level: integration.
11. **Program-level `--cwd <dir>` overrides startDir for both root detection and relative-path resolution** — Level: integration.
12. **An unexpected internal error exits 2 and writes the message to stderr** — simulated by injecting a backend that throws an ordinary `Error`. Level: integration.

**Components.**

```ts
// apps/cli/src/program-context.ts
export interface ProgramContext {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  cwd: string;
  exit: (code: number) => never;
}
```

```ts
// apps/cli/src/program.ts
import { Command } from "commander";
import type { ProgramContext } from "./program-context.js";

export function buildProgram(context?: Partial<ProgramContext>): Command;
```

`buildProgram` resolves a full `ProgramContext` (defaults to `process.stdout`/`process.stderr`/`process.cwd()`/`process.exit`), registers the `--version` action exactly as today, adds the program-level `--cwd <dir>` option, and delegates to `registerOverviewCommand`.

```ts
// apps/cli/src/commands/overview/register-overview-command.ts
import type { Command } from "commander";
import type { ProgramContext } from "../../program-context.js";

export function registerOverviewCommand(
  program: Command,
  context: ProgramContext,
): void;
```

```ts
// apps/cli/src/commands/overview/run-overview-action.ts
import type { ProgramContext } from "../../program-context.js";

export interface RunOverviewActionArgs {
  context: ProgramContext;
  file: string;
  json: boolean;
  cwdOverride: string | undefined;
}

export function runOverviewAction(args: RunOverviewActionArgs): Promise<void>;
```

The action: resolve `cwd` (override → `context.cwd`), `await NodeWorkspace.create({ startDir: cwd })`, build `[new TypeScriptBackend(workspace)]` and `new BackendRouter(...)`, import `runOverview` from `./run-overview.js` and `await runOverview({ workspace, router, cwd, inputPath: file })`, then call `writeOverviewOutput`. On `BackendError`, format via `formatUserError(err, { inputPath: file, workspaceRoot: workspace.root })`. On `NotInWorkspaceError` (which fires before the workspace exists), format via `formatUserError(err, { cwd })`. On any other error, write `err.message` to `context.stderr` and `context.exit(2)`.

```ts
// apps/cli/src/commands/overview/write-overview-output.ts
import type { FileSymbols } from "@symnav/core";

export function writeOverviewOutput(args: {
  symbols: FileSymbols;
  json: boolean;
  stdout: NodeJS.WritableStream;
}): void;
```

```ts
// apps/cli/src/error-output/format-user-error.ts
export interface FormatUserErrorContext {
  inputPath?: string;
  workspaceRoot?: string;
  cwd?: string;
}

export function formatUserError(err: unknown, ctx: FormatUserErrorContext): string | null;
```

**Algorithm notes (prose, not implementation).**

- **Program-level `--cwd`.** Added on the root `Command` so future subcommands inherit it. The overview action reads it via commander's `program.opts().cwd`, falling back to `context.cwd`.
- **`formatUserError`.** `instanceof` switch on the typed errors. For each `BackendError` subclass, build the line from the context: `inputPath` for the path token, `workspaceRoot` for the outside-workspace line, `path.extname(inputPath)` for the unsupported-extension line. For `NotInWorkspaceError`, use `cwd`. For anything else (including `BackendError` subclasses reached without the required context fields — a programming error), return `null` so the action falls through to exit 2.
- **`writeOverviewOutput`.** Single switch on `json`: true → `renderOverviewJson`, false → `renderOverviewText`. Both renderers already include the trailing newline.
- **Streams.** Production `cli.ts` calls `buildProgram()` with no arguments and lets defaults apply. Tests pass a `Partial<ProgramContext>` with buffer-backed writable streams and a recording `exit`.

**Commit plan.**

1. **`Add ProgramContext interface for the CLI`** — adds `src/program-context.ts`. *Hygiene: type alone.*
2. **`Refactor buildProgram to accept Partial<ProgramContext>`** — extends `program.ts` to accept options without changing `--version` behavior; the existing version e2e tests stay green. *Hygiene: refactor only.*
3. **`Test (unit): formatUserError builds Cannot answer lines from typed errors + context`** — adds `src/error-output/format-user-error.test.ts` covering cases 1–3. Fails. *Hygiene: red test.*
4. **`Add formatUserError`** — adds `src/error-output/format-user-error.ts`. Tests green. *Hygiene: pure helper.*
5. **`Add fake-program-context test helper for in-process program invocation`** — adds `test/integration/commands/overview/fake-program-context.ts`: buffer streams + recorder. *Hygiene: scaffolding alone.*
6. **`Test (integration): overview subcommand happy-path text and JSON output`** — adds `overview-command.test.ts` covering cases 4–5 + 11. Fails (subcommand not registered). *Hygiene: red.*
7. **`Add writeOverviewOutput, runOverviewAction (happy path), and registerOverviewCommand`** — adds the three files and registers the subcommand from `buildProgram`; the action imports `runOverview` from the Phase 8 sibling file. Cases 4–5 + 11 green. *Hygiene: feature impl across three single-purpose files.*
8. **`Test (integration): overview surfaces user errors via Cannot answer voice and exits 1/2`** — adds cases 6–10 + 12. Fails. *Hygiene: red.*
9. **`Wire BackendError / NotInWorkspaceError handling in runOverviewAction with exit 1, fallback exit 2`** — fills the catch-and-format flow. Tests green. *Hygiene: feature impl.*

**Done when.** Twelve test cases plus the existing version e2e tests pass. `pnpm --filter symnav dev -- overview <file>` against a real workspace produces text output; `--json` produces structured output; user errors produce the spec's `Cannot answer:` voice. `pnpm typecheck` / `pnpm lint` green.

---

## Phase 10 — `overview-cases` fixture and end-to-end snapshot tests

**Behavior delivered.** `packages/testing/fixtures/overview-cases/` exists with a self-contained set of TypeScript files exercising every Stage 1 scenario. `apps/cli/test/e2e/overview.test.ts` spawns the built `dist/cli.js` against the fixture (resolved via `fixturePath("overview-cases")`) and snapshot-matches stdout, stderr, and exit code for each scenario. A determinism test re-runs the same query and asserts byte-identical output across runs. This is the gating set of tests for Stage 1: when they all pass, the stage is done.

**File layout.**

```
packages/testing/fixtures/overview-cases/
  dot-git/                          # checked-in marker; renamed to .git at test setup
    HEAD
  .gitignore                        # contents: ignored.ts
  package.json
  class-with-methods.ts
  top-level-functions.ts
  top-level-constants.ts
  nested-symbols.ts
  empty.ts
  ignored.ts

apps/cli/test/
  e2e/
    overview/
      run-symnav-overview.ts        # local spawn helper (parallel to version.test.ts's runSymnav)
      ensure-fixture-git-marker.ts  # renames dot-git → .git before the suite
      overview.test.ts              # all twelve e2e cases
      __snapshots__/
        overview/
          class-with-methods.expected.txt
          class-with-methods.expected.json
          top-level-functions.expected.txt
          top-level-constants.expected.txt
          nested-symbols.expected.txt
          empty.expected.txt
          ignored.expected.err
          missing.expected.err
          outside.expected.err
          unsupported.expected.err
          no-git.expected.err
```

The fixture's `.git` directory is **checked in as `dot-git/`** to avoid the host repo treating it as a submodule. `ensureFixtureGitMarker` is invoked from a Vitest `beforeAll` (or globalSetup) and idempotently creates the `.git` symlink/copy from `dot-git/`. The teardown leaves `.git` in place (cheap, deterministic across reruns); only `dot-git/` is committed. This pins down the "implementer chooses" ambiguity from the original plan.

**Test cases.**

In `apps/cli/test/e2e/overview/overview.test.ts`, each test spawns `node dist/cli.js overview <args>` from `fixturePath("overview-cases")` via `runSymnavOverview`:

1. **`overview class-with-methods.ts`** — stdout matches `class-with-methods.expected.txt` (file snapshot); stderr empty; exit 0. Level: e2e.
2. **`overview top-level-functions.ts`** — analogous. Level: e2e.
3. **`overview top-level-constants.ts`** — analogous. Includes `export default` and ambient `declare const`. Level: e2e.
4. **`overview nested-symbols.ts`** — analogous. Includes namespace → class → method, interface members, enum. Level: e2e.
5. **`overview empty.ts`** — stdout exactly `Overview: empty.ts\n\n(no symbols)\n`; exit 0. Level: e2e.
6. **`overview ignored.ts`** — stderr matches `ignored.expected.err`; exit 1. Level: e2e.
7. **`overview missing.ts`** — stderr matches `missing.expected.err`; exit 1. Level: e2e.
8. **`overview ../some-file-outside.ts`** with `--cwd` set such that the target falls outside the fixture's workspace — stderr matches `outside.expected.err`; exit 1. Level: e2e.
9. **`overview package.json`** — stderr matches `unsupported.expected.err` citing `.json`; exit 1. Level: e2e.
10. **`overview class-with-methods.ts --json`** — stdout matches `class-with-methods.expected.json` byte-for-byte; exit 0. Level: e2e.
11. **Determinism: running case 1 twice produces byte-identical stdout** — Level: e2e.
12. **No-`.git` workspace error** — `runSymnavOverview` invoked with `--cwd <os.tmpdir()>` against a fresh empty temp dir; stderr matches `no-git.expected.err`; exit 1. Level: e2e.

**Components.**

```ts
// apps/cli/test/e2e/overview/run-symnav-overview.ts
export interface SymnavRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runSymnavOverview(args: readonly string[], cwd: string): SymnavRunResult;
```

Mirrors `version.test.ts`'s `runSymnav` but takes `cwd` explicitly. Lives next to its consumer rather than in `@symnav/testing`, per AGENTS.md.

```ts
// apps/cli/test/e2e/overview/ensure-fixture-git-marker.ts
export function ensureFixtureGitMarker(fixtureRoot: string): void;
```

Idempotent: if `<fixtureRoot>/.git` already exists, no-op; otherwise copy `<fixtureRoot>/dot-git` to `<fixtureRoot>/.git`. The fixture is then ready for `NodeWorkspace.create` to find a git root.

Fixture `package.json`:

```json
{ "name": "overview-cases", "private": true, "type": "module" }
```

Fixture `.gitignore`:

```
ignored.ts
```

**Commit plan.**

1. **`Add overview-cases fixture skeleton`** — adds the directory with `package.json`, `.gitignore`, `dot-git/HEAD`, and the per-scenario `.ts` files. No test consumes it yet. *Hygiene: pure addition; no `.git` directory checked in.*
2. **`Add ensureFixtureGitMarker e2e helper`** — adds `apps/cli/test/e2e/overview/ensure-fixture-git-marker.ts` with a unit test that round-trips dot-git → .git on a tmp dir. *Hygiene: helper + its own test.*
3. **`Add runSymnavOverview spawn helper`** — adds `apps/cli/test/e2e/overview/run-symnav-overview.ts`. *Hygiene: helper alone, parallel to runSymnav from version.test.ts.*
4. **`Test (e2e): overview happy-path snapshots — class, functions, constants, nested, empty`** — adds the e2e test file with cases 1–5, gated on `ensureFixtureGitMarker` in `beforeAll`. Snapshot files committed empty; first test run writes them. *Hygiene: test file plus empty expected files.*
5. **`Capture initial expected snapshots for overview happy-path tests`** — running the tests fills the `.expected.txt` files; commit them in their own commit so reviewers can diff snapshot bytes. *Hygiene: machine-generated artifacts alone.*
6. **`Test (e2e): overview user-error snapshots — ignored, missing, outside, unsupported`** — adds cases 6–9. *Hygiene: test additions only.*
7. **`Capture initial expected snapshots for overview error-path tests`** — *Hygiene: snapshot bytes alone.*
8. **`Test (e2e): overview --json snapshot matches IR byte-for-byte`** — adds case 10. *Hygiene: test alone.*
9. **`Capture initial expected JSON snapshot for overview --json`** — *Hygiene: snapshot bytes alone.*
10. **`Test (e2e): overview determinism — same query produces identical stdout`** — adds case 11. *Hygiene: test alone.*
11. **`Test (e2e): overview no-git error path against an empty tmp directory`** — adds case 12. *Hygiene: test alone.*
12. **`Capture expected snapshot for overview no-git error path`** — *Hygiene: snapshot bytes alone.*
13. **`Document overview command and overview-cases fixture in AGENTS.md / CLAUDE.md`** — short documentation diff so contributors discover the conventions: how to run `overview`, where the fixture lives, the `dot-git → .git` marker convention. *Hygiene: docs alone.*

**Done when.** All twelve e2e cases pass against the spawned binary, identical bytes on re-runs, and the full pre-PR sequence (`pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint && pnpm typecheck`) is green. CI passes on the resulting branch.

---

## Out of scope

Explicitly **not** in this stage; deferred to the listed future work:

- **Cross-file resolution and tsconfig discovery** — Stage 2 (`resolve` / `def`) introduces tsconfig handling. Stage 1's TypeScript backend operates in single-file mode.
- **Canonical-symbol-ID rules including overload disambiguators (`#overload1`, `#implementation`)** — Stage 2 locks the canonical-ID composition. Stage 1's `overview` may surface multiple decls with the same `name` for overloads; the rendered output uses the bare name. The `overview-cases` fixture deliberately omits overloads.
- **References, callers, callees, graphs** — Stages 3–5.
- **Pagination flags (`--page`, `--page-size`, `--all`)** — `overview` produces a single bounded result; pagination first appears in `refs` (Stage 3).
- **ANSI styling for matched-symbol highlight** — `overview` highlights nothing. The "no-ANSI-when-piped" rule is locked at the renderer level for future use; Stage 1 emits no ANSI in either mode.
- **Performance baseline and binary publishing** — Stage 6 (release hardening).
- **Daemon mode and additional language backends** — explicitly post-v1 per the stages plan.
- **Global gitignore (`core.excludesFile`) and `.git/info/exclude`** — Stage 1 honors only in-workspace `.gitignore` files. Documented in this plan and in the contributor guide.
