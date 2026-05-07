# Stage 1 — `overview`: Phased Plan

A phased, TDD-driven implementation of [Stage 1 of the symnav stages plan](../symnav-stages.md): the `symnav overview <file>` command, the IR shape, the renderer's first surface, and the language-backend interface — i.e. the walking skeleton through the full architecture.

## Goal

When this plan is complete:

- `pnpm --filter symnav dev -- overview <file>` (and the built `symnav overview <file>`) prints the symbol structure of a TypeScript file: hierarchy, signatures, line ranges, matching the [functional spec's `overview` examples](../symnav-functional-spec.md).
- `--json` produces a structured variant whose shape mirrors the in-memory IR.
- Workspace root detection (walk to nearest `.git`), `--cwd` override, `.gitignore` honoring, and the four user-error paths (missing / outside-workspace / ignored / unsupported extension) are all implemented and tested.
- The TypeScript backend is wired through ts-morph using a `FileSystemHost` adapted from `core`'s `WorkspaceFileSystem` port, so the adapter is an in-memory swap away from real disk for tests.
- E2E snapshot tests against a `packages/testing/fixtures/overview-cases/` project gate the stage. Re-running the same query against the same workspace produces byte-identical output (determinism asserted in CI).

The IR (`SymbolDecl`, `FileSymbols`, `LineRange`, `SymbolKind`), the `LanguageBackend` interface, the `Workspace` abstraction, and the renderer's tree-output rules are all locked here. Stages 2–5 extend these contracts; they do not redefine them.

## Context

Stage 0 left the workspace at empty placeholders. Today every package's `src/index.ts` is `export {};` and the only real production code is `apps/cli` with `commander` wiring `--version`. Stage 1 begins to fill them in.

Relevant existing pieces this plan plugs into:

- **`packages/core`** — currently empty (`export {};`). Owns IR types, workspace services, the language-backend interface, command logic, and shared error types after this stage.
- **`packages/renderer`** — currently empty. Adds `renderOverviewText` and `renderOverviewJson` against the IR exported by `core`.
- **`packages/backend-typescript`** — currently empty. Adds `TypeScriptBackend` plus a pure layer of extraction helpers over ts-morph.
- **`apps/cli/src/program.ts`** — currently has only the `--version` action. The `overview` subcommand is registered here.
- **`packages/testing`** — currently exports `fixturePath`. Grows two helpers: `inMemoryWorkspace({ files })` for `Workspace`-level tests and `parseTs(source)` for unit-testing the backend's pure layer.
- **`packages/testing/fixtures/`** — currently has `trivial-project/`. Stage 1 adds `overview-cases/`, a self-contained per-scenario fixture project.
- **`apps/cli/test/e2e/version.test.ts`** — establishes the e2e shape (spawn `dist/cli.js` with `spawnSync`, `cwd` set to a fixture). New e2e tests follow that shape.
- **`meta-tests/`** — no changes: this stage adds no new packages and does not touch the dependency-direction graph encoded in `eslint.config.mjs` or root `tsconfig.json`.

The dependency direction is locked by Stage 0 and remains:
`@symnav/core` → ∅; `@symnav/renderer` → core; `@symnav/backend-typescript` → core; `apps/cli` → core, renderer, backend-typescript; `@symnav/testing` → core (test files anywhere may import testing).

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

## Phase 4 — TypeScript backend pure layer

**Behavior delivered.** `packages/backend-typescript` exports a set of pure functions over already-parsed ts-morph nodes that produce the IR types from Phase 1. These functions are the bulk of the backend and are testable without disk or workspace, by parsing source strings inline via `parseTs(source)` from `@symnav/testing`. The adapter that owns disk IO comes in Phase 5.

**Test cases.**

`@symnav/testing` first grows `parseTs(source: string): SourceFile`, validated by:

1. **`parseTs` returns a ts-morph `SourceFile` with the given content** — `source.getFullText()` round-trips. Level: unit. File: `packages/testing/src/parse-ts.test.ts`.

In `packages/backend-typescript/src/extract.test.ts`, all driven by `parseTs`:

2. **Top-level `function` produces a `function` SymbolDecl with declaration-text-minus-body signature** — input: `export function greet(name: string): string { return name; }`. Asserts `kind: "function"`, `name: "greet"`, `range`, `signature: "export function greet(name: string): string"`. Level: unit.
3. **Async / generator / generic / optional / overloaded function declarations** — five separate cases assert signature and kind. Level: unit.
4. **Top-level `class` produces `class` decl with members as children** — input: a class with constructor, method, getter, setter, property, static method, abstract method (on an abstract class). Asserts each child's kind and the parent's signature ends at `{` (no body). Level: unit.
5. **Top-level `interface` produces `interface` decl with members as children** — properties, methods, index signature, call signature, construct signature. Level: unit.
6. **Top-level `type` alias produces `type-alias` decl with capped signature** — long RHS gets ellipsized at the cap (proposed 120 chars; implementation pins the exact value). Level: unit.
7. **Top-level `enum` produces `enum` decl** — signature is the declaration line up to `{`. No children. Level: unit.
8. **Top-level `namespace` produces `namespace` decl with recursive children** — nested function inside namespace appears as a child function decl. Level: unit.
9. **`const` / `let` / `var` produce `variable` decls** — annotated form renders `const X: T`; unannotated with literal initializer renders `const X = <literal>`; long initializer is ellipsized at the cap. Level: unit.
10. **A single `const a = 1, b = 2` statement produces two separate `variable` decls** — each with its own range. Level: unit.
11. **`export default <expr>` produces a `default-export` decl** — `name: "default"`. Signature is the expression text or class/function declaration form. Level: unit.
12. **Re-exports and bare `import` statements produce no decls** — `export { foo } from "./x"` and `import "./side-effect"` are skipped. Level: unit.
13. **Empty source produces empty `symbols` array** — Level: unit.
14. **Source order is preserved across siblings** — declarations in source order remain in IR order. Level: unit.
15. **Single-line and multi-line ranges are emitted correctly** — single-line decl has `startLine === endLine`; multi-line decl spans exact source lines. Level: unit.
16. **`extractFileSymbols` returns the supplied `filePath` verbatim on the IR** — Level: unit.

The kind classifier and signature renderer are exercised primarily through `extractFileSymbols`; if their internal helpers are kept as exported functions for direct testing, each has a focused test (e.g. `nodeKind` returns `"getter"` for a `GetAccessorDeclaration`).

**Components.**

```ts
// packages/testing/src/parse-ts.ts
import type { SourceFile } from "ts-morph";

/**
 * Parse a TypeScript source string in an in-memory ts-morph project and
 * return the SourceFile. Used by unit tests of the TS backend's pure layer.
 *
 * Filename defaults to "test.ts"; pass an override (e.g. "test.tsx", "decls.d.ts")
 * for kind-specific behavior.
 */
export function parseTs(source: string, fileName?: string): SourceFile;
```

```ts
// packages/backend-typescript/src/extract.ts
import type { Node, SourceFile } from "ts-morph";
import type { FileSymbols, LineRange, SymbolDecl, SymbolKind } from "@symnav/core";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
}): FileSymbols;

export function extractTopLevel(sourceFile: SourceFile): readonly SymbolDecl[];
export function extractChildren(parent: Node): readonly SymbolDecl[];

export function nodeKind(node: Node): SymbolKind | null;
export function nodeName(node: Node): string;
export function nodeRange(node: Node): LineRange;
export function renderSignature(node: Node): string;
```

```ts
// packages/backend-typescript/src/signature-cap.ts
/** Maximum width of a rendered signature before ellipsis. */
export const SIGNATURE_CAP_CHARS = 120;
/** Ellipsis token appended when a signature exceeds the cap. */
export const SIGNATURE_ELLIPSIS = "…";
```

`packages/testing/src/index.ts` adds `export { parseTs } from "./parse-ts.js";`.

**Algorithm notes (prose, not implementation).**

- **`extractTopLevel`.** Iterate `sourceFile.getStatements()`. For each, classify via `nodeKind`. Skip nulls (re-exports, bare imports, etc.). For `VariableStatement`, expand into one decl per declared name. Build `SymbolDecl` from name, range, signature, and `extractChildren(node)` (empty for leaves; non-empty for class/interface/namespace).
- **`renderSignature`.** Source-text-driven. For functions/methods, the declaration text up to (but not including) the body brace, dropping any trailing `;`. For class/interface/enum/namespace, the declaration text up to the opening `{`. For type aliases, the declaration text up to either the next top-level statement or the terminating `;`, capped + ellipsized. For variables, `const|let|var <name>` plus annotation if present, plus initializer if no annotation, capped + ellipsized.
- **`nodeKind` mapping.** A small switch over ts-morph `SyntaxKind`s to the `SymbolKind` union. Unhandled kinds return `null` (skipped silently). Concrete mapping is implementation-time but the test suite enumerates each `SymbolKind` value through at least one input.

**Dependency:** `ts-morph` added to `packages/backend-typescript/package.json` and to `packages/testing/package.json` (the latter as a dependency since `parseTs` lives there). The version is the latest stable resolved at implementation time.

**Commit plan.**

1. **`Add ts-morph dependency to @symnav/testing and @symnav/backend-typescript`** — package.json + lockfile updates only. *Hygiene: dependency change alone.*
2. **`Test (unit): parseTs returns a ts-morph SourceFile`** — adds `packages/testing/src/parse-ts.test.ts`. Fails because `parseTs` doesn't exist. *Hygiene: red test.*
3. **`Implement parseTs in @symnav/testing`** — adds `parse-ts.ts` and re-exports. Test green. *Hygiene: smallest impl.*
4. **`Add signature-cap constants in backend-typescript`** — adds `signature-cap.ts`. *Hygiene: constants alone, used in next commits.*
5. **`Test (unit): nodeKind classifier covers Stage 1 SymbolKind vocabulary`** — focused tests for `nodeKind` over each declaration form. *Hygiene: red test, fine-grained.*
6. **`Implement nodeKind classifier`** — adds `extract.ts` with `nodeKind` and supporting node-name/range helpers (the latter trivial). *Hygiene: classifier first.*
7. **`Test (unit): renderSignature for functions, methods, classes, interfaces, types, enums, namespaces, variables`** — exhaustive coverage of cases 2–11 except parts that depend on full extraction. *Hygiene: red tests.*
8. **`Implement renderSignature with source-text rules and signature cap`** — fills the renderer. Tests green. *Hygiene: feature impl.*
9. **`Test (unit): extractFileSymbols produces FileSymbols matching IR shape`** — covers cases 12–16: top-level enumeration, children, source order, default export, skipped statements, empty file. *Hygiene: red tests for the integrating function.*
10. **`Implement extractFileSymbols and extractChildren`** — wires the helpers; tests green. *Hygiene: integrating impl.*

**Done when.** All sixteen test cases pass. `pnpm typecheck` and `pnpm lint` green. The pure layer is fully exercised without a `Workspace` or disk.

---

## Phase 5 — TypeScript backend adapter (`TypeScriptBackend`)

**Behavior delivered.** `packages/backend-typescript` exports `TypeScriptBackend`, a `LanguageBackend` implementation that uses ts-morph driven by a `FileSystemHost` adapted from `core`'s `WorkspaceFileSystem`. `accepts(filePath)` returns true for `.ts`, `.tsx`, `.mts`, `.cts`, and `.d.ts`. `fileSymbols(filePath)` loads the requested file via the workspace's filesystem, hands the resulting `SourceFile` to `extractFileSymbols`, and returns the IR. No tsconfig is loaded; ts-morph runs in single-file mode.

**Test cases.**

In `packages/backend-typescript/test/integration/typescript-backend.test.ts`:

1. **`accepts` returns true for `.ts`/`.tsx`/`.mts`/`.cts`/`.d.ts`, false for `.js`/`.json`/`.md`** — Level: integration.
2. **`fileSymbols` produces IR matching extracted output for an in-memory file** — given an in-memory workspace with `src/x.ts` containing a known class, calling the backend returns IR identical to `extractFileSymbols` over the same source. Level: integration. Fixture: `inMemoryWorkspace`.
3. **`fileSymbols` returns `filePath` as the workspace-relative POSIX path** — even when the filesystem stores absolute paths internally. Level: integration.
4. **`fileSymbols` reads the file through `Workspace.fs`, not directly from disk** — wrap `inMemoryFileSystem` with a counting decorator, assert `readFile` was called for the requested path. Level: integration.
5. **`fileSymbols` on a nonexistent file throws `FileNotFoundError`** — Level: integration. (The user-visible flow validates earlier in `runOverview`; this asserts the backend's defense-in-depth contract.)

**Components.**

```ts
// packages/backend-typescript/src/typescript-backend.ts
import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";

export const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"] as const;

export class TypeScriptBackend implements LanguageBackend {
  constructor(workspace: Workspace);
  accepts(filePath: string): boolean;
  fileSymbols(filePath: string): Promise<FileSymbols>;
}
```

```ts
// packages/backend-typescript/src/file-system-host.ts
import type { WorkspaceFileSystem } from "@symnav/core";
import type { FileSystemHost } from "ts-morph";

/**
 * Adapt our WorkspaceFileSystem to ts-morph's FileSystemHost so that ts-morph
 * never reaches the real filesystem when a custom workspace fs is in use.
 * Methods unused by single-file overview throw or no-op explicitly so a future
 * use-case forces an explicit decision rather than silent disk access.
 */
export function fileSystemHostFromWorkspace(
  fs: WorkspaceFileSystem,
): FileSystemHost;
```

```ts
// packages/backend-typescript/src/index.ts
export { TypeScriptBackend, TS_EXTENSIONS } from "./typescript-backend.js";
```

**Algorithm notes (prose, not implementation).**

- **`accepts`.** Lowercase the path's basename; check against `TS_EXTENSIONS`. Order matters for `.d.ts` vs `.ts` — match `.d.ts` first.
- **`fileSymbols`.** Resolve the workspace-relative path to absolute via `workspace.toAbsolute`. Use a per-call ts-morph `Project` with `useInMemoryFileSystem: false` and the custom `fileSystemHostFromWorkspace(workspace.fs)` host. `addSourceFileAtPath` to load the file. If the project rejects (file missing), throw `FileNotFoundError`. Hand the `SourceFile` to `extractFileSymbols`. The `Project` is discarded with the call (cold-per-invocation).

**Commit plan.**

1. **`Test (integration): TypeScriptBackend.accepts honors TS extensions`** — adds the test file with case 1. Fails (class doesn't exist). *Hygiene: red test alone.*
2. **`Add TS_EXTENSIONS constant and TypeScriptBackend.accepts`** — adds `typescript-backend.ts` with constructor, `accepts`, and a stub `fileSymbols` that throws. Tests for case 1 green. *Hygiene: smallest acceptable impl for the failing test.*
3. **`Add fileSystemHostFromWorkspace adapter`** — adds `file-system-host.ts`. *Hygiene: adapter type alone, no callsites yet.*
4. **`Test (integration): TypeScriptBackend.fileSymbols produces IR via Workspace.fs`** — adds cases 2–5. Tests fail (`fileSymbols` is a stub). *Hygiene: red tests.*
5. **`Implement TypeScriptBackend.fileSymbols using ts-morph and the workspace fs host`** — wires extract + adapter. Tests green. *Hygiene: implementation.*
6. **`Re-export TypeScriptBackend from package entry`** — *Hygiene: surface only.*

**Done when.** Five new integration tests pass. The backend reads exclusively through `Workspace.fs` (verified by case 4). `pnpm typecheck` / `pnpm lint` green.

---

## Phase 6 — Overview renderer (text + JSON)

**Behavior delivered.** `packages/renderer` exports `renderOverviewText(file: FileSymbols): string` and `renderOverviewJson(file: FileSymbols): string`. Given any `FileSymbols` IR, the text renderer produces output matching the spec's `overview` shape exactly: header, blank line, top-level entries flat with 3-space-indented signatures, nested entries with `├──`/`└──`/`│   ` Unicode tree characters, `(no symbols)` for empty files, trailing newline. The JSON renderer produces 2-space-indented sorted-key output with `children` always present and a trailing newline.

**Test cases.**

In `packages/renderer/src/overview.test.ts`, all driven by hand-built `FileSymbols` literals:

1. **Empty file renders header + `(no symbols)` + trailing newline** — Level: unit.
2. **Single top-level function renders flat with 3-space signature indent** — Level: unit. Snapshot via `toMatchInlineSnapshot`.
3. **Multiple top-level entries are separated by blank lines** — three top-level decls; output has exactly two blank-line separators. Level: unit.
4. **Class with three methods uses `├──`/`└──` and `│   `/`    ` correctly** — last method uses `└──` and `    ` for the signature continuation. Level: unit.
5. **Three-deep nesting (namespace → class → method) indents correctly** — Level: unit.
6. **Single-line range renders as `8`, multi-line as `12-96`** — Level: unit.
7. **Symbol path includes ancestors joined by `::`** — Level: unit.
8. **Output ends with exactly one trailing newline** — Level: unit, asserted on every text-render test via a shared `assertTrailingNewline` helper.
9. **JSON output mirrors `FileSymbols` verbatim, with `children` always present** — leaf decls render `"children": []` rather than omitting the key. Level: unit.
10. **JSON output is 2-space-indented with sorted keys and a trailing newline** — Level: unit.
11. **JSON renders identical bytes for identical IR across two calls** — determinism. Level: unit.

**Components.**

```ts
// packages/renderer/src/overview.ts
import type { FileSymbols } from "@symnav/core";

export function renderOverviewText(file: FileSymbols): string;
export function renderOverviewJson(file: FileSymbols): string;
```

```ts
// packages/renderer/src/tree-glyphs.ts
export const TREE_BRANCH = "├── ";
export const TREE_LAST = "└── ";
export const TREE_VERTICAL = "│   ";
export const TREE_SPACE = "    ";
export const SIGNATURE_INDENT = "   "; // 3 spaces, top-level signature line
```

```ts
// packages/renderer/src/index.ts
export { renderOverviewText, renderOverviewJson } from "./overview.js";
```

**Algorithm notes (prose, not implementation).**

- **Text rendering.** Two passes: (1) emit header `Overview: <filePath>` and blank line; (2) walk top-level `symbols` in order, each producing a two-line block (`<range>: <symbol-path>` then `<3sp><signature>`), separated by blank lines. For each top-level decl with non-empty `children`, recursively emit child blocks with tree prefixes — `├── ` / `└── ` chosen by sibling position; the signature line uses `│   ` or `    ` matching the chosen branch. The recursive prefix accumulates the parent prefix unchanged for non-last branches and replaces the last `│   ` with `    ` for descendants under a closed branch.
- **Empty file.** `Overview: <filePath>\n\n(no symbols)\n`.
- **JSON rendering.** Build a plain JS object literal from the IR, ensuring `children` is always an array (even empty). Use `JSON.stringify(value, sortKeys, 2)` where `sortKeys` is a replacer that sorts each object's keys. Append `\n`.

**Commit plan.**

1. **`Add tree-glyph constants in @symnav/renderer`** — `tree-glyphs.ts`. *Hygiene: constants alone.*
2. **`Test (unit): renderOverviewText shape — header, empty file, single decl`** — adds `overview.test.ts` with cases 1–2 + 8. Fails. *Hygiene: red tests.*
3. **`Implement renderOverviewText for flat top-level shape`** — adds `overview.ts` with text rendering for top-level only (no children). Cases 1–2 + 8 green. *Hygiene: smallest impl.*
4. **`Test (unit): renderOverviewText nested entries with tree glyphs`** — adds cases 3–7. Fails for the nested-tree behavior. *Hygiene: red tests.*
5. **`Extend renderOverviewText to handle nested children with tree prefixes`** — implements the recursive walk. Tests green. *Hygiene: feature impl.*
6. **`Test (unit): renderOverviewJson mirrors IR with sorted keys and stable bytes`** — adds cases 9–11. Fails. *Hygiene: red tests.*
7. **`Implement renderOverviewJson with stable sorted-key serialization`** — *Hygiene: impl.*
8. **`Re-export overview renderers from @symnav/renderer entry`** — *Hygiene: surface only.*

**Done when.** Eleven test cases pass. The renderer is consumable from `apps/cli` in Phase 8. `pnpm typecheck` / `pnpm lint` green.

---

## Phase 7 — Overview command logic in `@symnav/core`

**Behavior delivered.** `@symnav/core` exports `runOverview(args)`, the pure command logic that orchestrates: resolve user-supplied path against `cwd` → check existence → check workspace membership → check ignore → route to a backend → return `FileSymbols`. Each validation failure throws the appropriate `BackendError` from Phase 3. The command is independently testable with a fake backend; no real backend, renderer, or CLI is involved.

**Test cases.**

In `packages/core/test/integration/run-overview.test.ts`, all driven by `inMemoryWorkspace` and a fake `LanguageBackend`:

1. **Happy path: relative input path, workspace member, not ignored, accepted** — returns the fake backend's IR. Level: integration.
2. **Absolute input path — same shape, returns same IR** — Level: integration.
3. **Relative path resolves against `cwd`, not workspace root** — `cwd` is a subdirectory; passing `x.ts` resolves to `<cwd>/x.ts`, not `<root>/x.ts`. Level: integration.
4. **Missing file → `FileNotFoundError` with displayed path matching user input** — Level: integration.
5. **Path outside workspace → `OutsideWorkspaceError`** — Level: integration.
6. **Ignored path → `IgnoredFileError`** — Level: integration.
7. **No backend accepts → `UnsupportedFileError` with the actual file extension on the error** — Level: integration.
8. **Validation order: missing > outside > ignored > unsupported** — when several conditions fail simultaneously (e.g. missing file outside workspace), the *first* applicable error wins. Each combination asserted separately. Level: integration.
9. **Backend is invoked with the workspace-relative POSIX path, not absolute, not platform-native** — verified via a recording fake. Level: integration.

**Components.**

```ts
// packages/core/src/commands/overview.ts
import type { BackendRouter } from "../backend.js";
import type { FileSymbols } from "../ir.js";
import type { Workspace } from "../workspace.js";

export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;       // absolute; user's startDir for relative-path resolution
  inputPath: string; // raw user-supplied path (relative or absolute)
}

export function runOverview(args: RunOverviewArgs): Promise<FileSymbols>;
```

`packages/core/src/index.ts` adds:
```ts
export { runOverview } from "./commands/overview.js";
export type { RunOverviewArgs } from "./commands/overview.js";
```

**Algorithm notes (prose, not implementation).**

- Resolve `inputPath` to an absolute path: if absolute, use as-is; otherwise `path.resolve(cwd, inputPath)`. Track a `displayedPath` for error messages — for relative inputs, the original input string; for absolute inputs, the absolute path.
- Sequence: existence → in-workspace → ignored → routed-backend.
- Pass the workspace-relative POSIX path to the backend (`workspace.toRelative(absPath)`).

**Commit plan.**

1. **`Test (integration): runOverview happy-path returns backend IR`** — adds `run-overview.test.ts` with cases 1–3 + 9 against a fake backend. Fails (function doesn't exist). *Hygiene: red.*
2. **`Add runOverview signature and happy-path implementation`** — adds `commands/overview.ts`. Cases 1–3 + 9 green. *Hygiene: smallest impl.*
3. **`Test (integration): runOverview validation errors and ordering`** — adds cases 4–8. Fails. *Hygiene: red.*
4. **`Implement runOverview validation gates with typed errors and locked order`** — fills the validation sequence. *Hygiene: feature impl.*
5. **`Re-export runOverview from @symnav/core entry`** — *Hygiene: surface only.*

**Done when.** Nine integration tests pass. `runOverview` is fully testable without ts-morph or a real backend. `pnpm typecheck` / `pnpm lint` green.

---

## Phase 8 — CLI `overview` subcommand

**Behavior delivered.** `apps/cli/src/program.ts` registers an `overview` subcommand with positional `<file>`, `--json` flag, and the global `--cwd <dir>` option. The CLI builds a `Workspace`, instantiates `[new TypeScriptBackend(workspace)]`, calls `runOverview`, and writes either the text or JSON renderer's output to stdout. `BackendError`s are caught and printed to stderr in the spec's `Cannot answer: <reason>.` voice with exit code 1. `NotInWorkspaceError` (no `.git` ancestor) yields its own `Cannot answer:` form with exit 1. Unexpected errors propagate to stderr with exit 2.

This phase introduces no new runtime dependencies; everything wires existing pieces.

**Test cases.**

Integration tests in `apps/cli/test/integration/overview-program.test.ts` invoke the program object directly (no subprocess) against `inMemoryWorkspace`, asserting on stdout/stderr captured via test-controlled writable streams. (The CLI's writable streams are exposed via a small helper so the program can write to injected streams during tests; spawn-based e2e is in Phase 9.)

1. **`overview <file>` writes text-rendered IR to stdout, exit 0** — Level: integration.
2. **`overview <file> --json` writes JSON to stdout, exit 0** — Level: integration.
3. **`overview` on a missing file writes `Cannot answer: file not found: <path>.` to stderr, exit 1** — Level: integration.
4. **`overview` on a path outside the workspace writes the outside-workspace `Cannot answer:` line, exit 1** — Level: integration.
5. **`overview` on an ignored path writes the ignored `Cannot answer:` line, exit 1** — Level: integration.
6. **`overview` on a `.json` file writes the unsupported-extension `Cannot answer:` line, exit 1** — Level: integration.
7. **`overview` with no `.git` in or above `cwd` writes `Cannot answer: not in a git workspace…`, exit 1** — Level: integration.
8. **Global `--cwd <dir>` overrides startDir for both root detection and relative-path resolution** — Level: integration.
9. **An unexpected internal error exits 2** — simulated by a backend that throws an ordinary `Error`. Level: integration.

**Components.**

```ts
// apps/cli/src/program.ts
import { Command } from "commander";

export interface BuildProgramOptions {
  /** Streams used for output. Defaults to process.stdout/stderr. Tests inject. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Override process.cwd default for tests. */
  cwd?: string;
  /** Override process.exit so tests can capture exit codes. */
  exit?: (code: number) => never;
}

export function buildProgram(options?: BuildProgramOptions): Command;
```

```ts
// apps/cli/src/commands/overview.ts
import type { Command } from "commander";
import type { BuildProgramOptions } from "../program.js";

export function registerOverviewCommand(
  program: Command,
  context: Required<BuildProgramOptions>,
): void;
```

```ts
// apps/cli/src/error-output.ts
import type { BackendError, NotInWorkspaceError } from "@symnav/core";

/** Format a BackendError or NotInWorkspaceError as a single-line "Cannot answer:" string with trailing period. */
export function formatUserError(err: unknown): string | null;
```

**Algorithm notes (prose, not implementation).**

- The `overview` action: build `cwd` from options (falling back to `--cwd` then `process.cwd()`), construct the `Workspace` via `createWorkspace`, build `[new TypeScriptBackend(workspace)]`, build a `BackendRouter`, call `runOverview`. On success, dispatch to the appropriate renderer and write to stdout. On `BackendError` or `NotInWorkspaceError`, format via `formatUserError`, write to stderr with a trailing newline, exit 1. Otherwise rethrow into commander's default error handling and exit 2.
- The `--cwd` option is added at the program (not subcommand) level so future commands inherit it.
- Tests inject `stdout`, `stderr`, `cwd`, and `exit` via `BuildProgramOptions`; production `cli.ts` keeps using defaults.

**Commit plan.**

1. **`Add error-output formatter for BackendError and NotInWorkspaceError`** — adds `error-output.ts` with `formatUserError`. Tested via a small unit test that builds each error type and asserts the formatted line. *Hygiene: pure helper, isolated commit.*
2. **`Add BuildProgramOptions: inject stdout, stderr, cwd, exit`** — refactors `program.ts` to accept options without changing existing `--version` behavior. The existing version e2e tests stay green. *Hygiene: refactor only, no behavior change.*
3. **`Test (integration): overview subcommand happy-path text and JSON output`** — adds `overview-program.test.ts` covering cases 1–2 + 8. Fails (subcommand not registered). *Hygiene: red.*
4. **`Register overview subcommand wiring runOverview and renderers`** — adds `commands/overview.ts` and registers it in `program.ts`. Cases 1–2 + 8 green. *Hygiene: feature impl.*
5. **`Test (integration): overview surfaces user errors via Cannot answer voice`** — adds cases 3–7 + 9. Fails. *Hygiene: red.*
6. **`Wire BackendError handling in overview action with exit 1, internal errors exit 2`** — fills the catch-and-format flow. Tests green. *Hygiene: feature impl.*

**Done when.** Nine integration tests + the existing version e2e tests pass. Running `pnpm --filter symnav dev -- overview <file>` against a real workspace produces text output; `--json` produces structured output; user errors produce the spec's `Cannot answer:` voice. `pnpm typecheck` / `pnpm lint` green.

---

## Phase 9 — `overview-cases` fixture and end-to-end snapshot tests

**Behavior delivered.** `packages/testing/fixtures/overview-cases/` exists with a self-contained set of TypeScript files exercising every Stage 1 scenario. `apps/cli/test/e2e/overview.test.ts` spawns the built `dist/cli.js` against the fixture and snapshot-matches stdout, stderr, and exit code for each scenario. A determinism test re-runs the same query and asserts byte-identical output across runs. This is the gating set of tests for Stage 1: when they all pass, the stage is done.

**Test cases.**

In `apps/cli/test/e2e/overview.test.ts`, each test spawns `node dist/cli.js overview <args>` from the fixture root (matching the existing `runSymnav` helper from `version.test.ts`):

1. **`overview class-with-methods.ts`** — stdout matches `class-with-methods.expected.txt` (file snapshot); stderr empty; exit 0. Level: e2e.
2. **`overview top-level-functions.ts`** — analogous. Level: e2e.
3. **`overview top-level-constants.ts`** — analogous. Includes `export default` and ambient `declare const`. Level: e2e.
4. **`overview nested-symbols.ts`** — analogous. Includes namespace → class → method, interface members, enum. Level: e2e.
5. **`overview empty.ts`** — stdout exactly `Overview: empty.ts\n\n(no symbols)\n`; exit 0. Level: e2e.
6. **`overview ignored.ts`** — stderr exactly `Cannot answer: ignored.ts is ignored by .gitignore.\n`; exit 1. Level: e2e.
7. **`overview missing.ts`** — stderr `Cannot answer: file not found: missing.ts.\n`; exit 1. Level: e2e.
8. **`overview ../some-file-outside.ts` (with `--cwd` set such that target falls outside workspace)** — outside-workspace error; exit 1. Level: e2e.
9. **`overview package.json`** — unsupported-extension error citing `.json`; exit 1. Level: e2e.
10. **`overview class-with-methods.ts --json`** — stdout matches `class-with-methods.expected.json` byte-for-byte; exit 0. Level: e2e.
11. **Determinism: running case 1 twice produces byte-identical stdout** — Level: e2e. Implementation simply runs and diffs.
12. **No-`.git` workspace error** — temporarily run from a directory above the fixture (or use a separate tiny fixture without `.git`), assert the no-git error and exit 1. Level: e2e.

Snapshot files live alongside the test under `apps/cli/test/e2e/__snapshots__/overview/`, written via Vitest's `toMatchFileSnapshot`. The implementer writes the expected files by running the test once, eyeballing the output against the spec, and committing.

**Components.**

Fixture layout (`packages/testing/fixtures/overview-cases/`):

```
overview-cases/
  .git/                        # synthetic; just an empty file or directory marker
    HEAD                       # `ref: refs/heads/main\n` — enough to qualify as a git workspace
  .gitignore                   # contents: ignored.ts
  package.json                 # { "name": "overview-cases", "private": true, "type": "module" }
  class-with-methods.ts        # class with constructor, methods, properties, getter/setter, static, abstract base
  top-level-functions.ts       # function declarations: async, generic, with overloads
  top-level-constants.ts       # const/let/var (annotated and unannotated), export default
  nested-symbols.ts            # namespace → class → method; interface; enum
  empty.ts                     # zero bytes
  ignored.ts                   # presence-only; never the test target except for case 6
```

(`.git/` inside a fixture: since the repo's own `.gitignore` may or may not affect the fixture, the fixture's `.git` is committed as-is. To avoid the host repository treating it as a submodule, name it `.git` only at runtime via a small setup step in the test file — or check in the directory directly with the `.git` path replaced by a sentinel that the test renames at startup. The implementer chooses; the test must leave the working tree clean.)

```ts
// apps/cli/test/e2e/overview.test.ts (helper shape)
function runSymnavOverview(args: readonly string[], cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
};
```

The helper mirrors `version.test.ts`'s `runSymnav` but accepts an explicit `cwd`.

**Commit plan.**

1. **`Add overview-cases fixture skeleton`** — adds the directory with `package.json`, `.gitignore`, and the per-scenario `.ts` files. No `.git` yet (host repo would treat it as a submodule). *Hygiene: pure addition; no test consumes it yet.*
2. **`Add fixture .git marker handling for overview-cases`** — pin the chosen approach (committed `.git/HEAD` under a sentinel name, renamed at test setup, or a `setupFile` that constructs `.git/` before tests run). *Hygiene: setup machinery alone.*
3. **`Test (e2e): overview happy-path snapshots for class-with-methods, functions, constants, nested, empty`** — adds the e2e test file with cases 1–5 and the file-snapshot helper. Snapshot files committed empty initially; first test run writes them. *Hygiene: test file plus initial empty expected files.*
4. **`Capture initial expected snapshots for overview happy-path tests`** — running the tests fills the `.expected.txt` files; commit them. *Hygiene: machine-generated artifact in its own commit so reviewers can diff snapshot bytes.*
5. **`Test (e2e): overview user-error snapshots — ignored, missing, outside, unsupported`** — adds cases 6–9. *Hygiene: test additions only.*
6. **`Capture initial expected snapshots for overview error-path tests`** — fills the `.expected.txt`/error files. *Hygiene: snapshot bytes alone.*
7. **`Test (e2e): overview --json snapshot matches IR byte-for-byte`** — adds case 10. *Hygiene: test alone.*
8. **`Capture initial expected JSON snapshot for overview --json`** — *Hygiene: snapshot bytes alone.*
9. **`Test (e2e): overview determinism — same query produces identical stdout`** — adds case 11. *Hygiene: test alone.*
10. **`Test (e2e): overview no-git error path`** — adds case 12 with whichever no-`.git` strategy was chosen (separate fixture or `--cwd` pointing at `os.tmpdir()`). *Hygiene: test alone.*
11. **`Update AGENTS.md / CLAUDE.md with overview command usage and the new fixture`** — short documentation diff so contributors discover the conventions. *Hygiene: docs alone.*

**Done when.** All twelve e2e cases pass against the spawned binary, identical bytes on re-runs, and `pnpm test` is green across the workspace. CI's existing build + test + typecheck + lint pipeline goes green on the resulting branch.

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
