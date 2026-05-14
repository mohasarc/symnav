# Stage 1.5 — Foundation Hardening: Phased Plan

Detailed implementation plan for the seven deepenings of Stage 1.5, ordered by dependency.

Source: [`plans/000/symnav-stages.md`](../symnav-stages.md) § "Stage 1.5 — Foundation Hardening".

## Goal

When all phases land, the code Stage 1 shipped is consolidated so Stage 2 can add `resolve` and `def` without re-deriving scaffolding. Concretely: the IR carries a language-agnostic symbol role plus a backend native label and a numbered multi-line signature block; the workspace is built by one `createWorkspace` factory; ignore handling lives behind one `WorkspaceIgnore` class; input-path resolution is one `Workspace.resolveInputPath` call; errors render their own user-facing reason; and one `runCommand` seam owns command lifecycle. `overview`'s text output gains per-line source line numbers (a deliberate, intended change); its behavior is otherwise identical for every Stage 1 fixture. The `@symnav/core` public surface exports only what cross-package callers actually use.

## Context

**Packages.** `@symnav/core` (IR, workspace, backend interface, errors), `@symnav/renderer` (text + JSON overview renderers), `@symnav/backend-typescript` (ts-morph extraction), `symnav` / `apps/cli` (Commander wiring), `@symnav/testing` (fixtures, test utils — nothing moves into it in this plan).

**IR.** `packages/core/src/intermediate-representation/types.ts` defines `SymbolKind` (17 TS-specific literals), `LineRange`, `SymbolDecl` (`kind`, `name`, `range`, `signatureSource`, `children`), `FileSymbols`.

**Workspace.** `Workspace` interface (`workspace/workspace.ts`); `AbstractWorkspace` (`workspace/abstract-workspace.ts`, holds `root`/`fs`/`scopes`, methods `toRelative`/`toAbsolute`/`isInWorkspace`/`isIgnored`, `static resolveDependencies`); zero-override subclasses `NodeWorkspace`, `InMemoryWorkspace`. Ignore cluster: `workspace/ignore/{build-scopes,scope,is-ignored,path-relative}.ts`. The `.git/` rule is duplicated in `abstract-workspace.ts` (`isIgnored`) and `build-scopes.ts` (`walkGitignores`). Path helpers: `workspace/paths/{find-root,is-under-root,posixify,rel-from-root}.ts`. `FileSystem` interface + `NodeFileSystem` + `InMemoryFileSystem` (`workspace/in-memory/`, with `compute-dir-set.ts`).

**Errors.** `backend/errors.ts`: `BackendError` (behaviour-free base), `FileNotFoundError`, `IgnoredFileError`, `OutsideWorkspaceError`, `UnsupportedFileError` — all context-free constructors. `workspace/errors.ts`: `NotInWorkspaceError` (carries `startDir`).

**CLI.** `program.ts` (Commander, `ProgramContext`/`ProgramDependencies`), `commands/overview/{register-overview-command,run-overview-action,run-overview}.ts`, `error-output/format-user-error.ts` (overloaded formatter + `if instanceof` ladder). `ProgramContext` = `{ stdout, stderr, cwd, exit }`.

**Backend.** `typescript-backend/typescript-backend.ts` (`fileSymbols`, defensive `isInWorkspace` + existence checks — left untouched by this plan), `extract/{extract-file-symbols,extract-children,extract-signature-source,node-kind}.ts`.

**Tests.** Vitest. Unit colocated (`*.test.ts`); integration under `<pkg>/test/integration/`; e2e under `apps/cli/test/e2e/` (spawns the built binary, snapshots in `__snapshots__/`). Fixtures under `packages/testing/fixtures/` (`overview-cases`, `trivial-project`), resolved via `fixturePath`. `meta-tests/` asserts `eslint.config.mjs` / `tsconfig*.json` shape. CLI integration tests use `fake-program-context.ts` and `fake-language-backend.ts`.

**Dependency order of the seven deepenings.** #7 and #6 are isolated IR changes (no dependants among the others). #5 (`WorkspaceIgnore`) is consumed by #3's factory. #3's factory is the construction site #2's `resolveInputPath` is added to. #1's self-rendering errors are thrown by #2's `resolveInputPath`. #4's pipeline consumes #1, #2, #3. Hence: 7 → 6 → 5 → 3 → 1 → 2 → 4.

---

## Phase 1 — Symbol kinds split into role and native label

**Behavior delivered.** `SymbolDecl.kind` stops carrying a TypeScript-specific string. It carries `{ role, nativeLabel }`: a language-agnostic `SymbolRole` the renderer/future commands can branch on, plus a backend-supplied native label for faithful display. `@symnav/core` no longer exports a TypeScript-flavoured kind union. `overview` text output is unchanged (the renderer never branched on kind); JSON output's `kind` field changes shape.

**Test cases.**

- *IR shape — `SymbolDecl.kind` is `{ role, nativeLabel }`.* Unit, `packages/core` — a type-level/structural test (or the existing IR-consuming tests) expecting the nested object. Assertion: a constructed `SymbolDecl` has `kind.role` and `kind.nativeLabel`.
- *`roleOf` maps every native label to a role.* Unit, `packages/backend-typescript/src/extract/typescript-symbol-kind.test.ts` (new). Assertion: `roleOf("class") === "container"`, `roleOf("method") === "callable"`, `roleOf("variable") === "value"`, `roleOf("type-alias") === "type"`, and the signature kinds (`index-signature`, `call-signature`, `construct-signature`) map to their agreed role. Level: unit. One assertion per representative label across all four roles.
- *`nodeKind` returns the backend kind union.* Update `packages/backend-typescript/src/extract/node-kind.test.ts` — assertions unchanged in value, retyped to `TypeScriptSymbolKind`.
- *Extraction produces `{ role, nativeLabel }`.* Update `extract-children.test.ts` / `extract-file-symbols.test.ts` — assertions on `decl.kind` become `{ role, nativeLabel }`.
- *JSON renderer emits the nested kind.* Update `render-overview-json.test.ts` — `kind` is now an object.
- *e2e JSON snapshot.* Update `apps/cli/test/e2e/overview/__snapshots__/class-with-methods.expected.json` — every `"kind": "method"` becomes `"kind": { "nativeLabel": "method", "role": "callable" }` etc. No `.txt` or `.err` snapshot changes.
- *e2e text snapshots unchanged.* Existing `.txt` snapshot tests continue to pass untouched — confirms the role split is invisible to text output.

**Components.**

```ts
// packages/core/src/intermediate-representation/types.ts
export type SymbolRole = "container" | "callable" | "value" | "type";

export interface SymbolDecl {
  readonly kind: { readonly role: SymbolRole; readonly nativeLabel: string };
  readonly name: string;
  readonly range: LineRange;
  readonly signatureSource: string; // unchanged in this phase
  readonly children: readonly SymbolDecl[];
}
```

```ts
// packages/backend-typescript/src/extract/typescript-symbol-kind.ts  (new)
export type TypeScriptSymbolKind =
  | "class" | "interface" | "type-alias" | "enum" | "namespace"
  | "function" | "method" | "constructor" | "getter" | "setter"
  | "property" | "variable" | "default-export"
  | "index-signature" | "call-signature" | "construct-signature";

export function roleOf(kind: TypeScriptSymbolKind): SymbolRole;
```

```ts
// packages/backend-typescript/src/extract/node-kind.ts
export function nodeKind(node: Node): TypeScriptSymbolKind | null;
```

`roleOf` is a total mapping from the 16-literal union to one of four roles: containers = `class`/`interface`/`enum`/`namespace`; callables = `function`/`method`/`constructor`/`getter`/`setter`/`call-signature`/`construct-signature`; values = `variable`/`property`/`default-export`; types = `type-alias`/`index-signature`. The exact bucket for `default-export` and the signature kinds is the implementer's call within these four roles; it must be total (no `null`).

In `extract-children.ts`, `toMemberDecl` / `toStatementDecl` / `expandVariableStatement` build `kind: { role: roleOf(k), nativeLabel: k }` where `k` is the `TypeScriptSymbolKind`.

**Commit plan.**

1. **Rewrite test expectations for the nested kind shape.** Update every test and snapshot listed above to expect `kind: { role, nativeLabel }`; add `typescript-symbol-kind.test.ts`. Tests fail to compile / fail — the red commit. (TDD red commit; references types not yet defined.)
2. **Add `SymbolRole` to the core IR.** Type-only addition to `types.ts`, exported from `core/index.ts`, not yet referenced by `SymbolDecl`. (Type-only, no callsites yet.)
3. **Add `TypeScriptSymbolKind` and `roleOf` to the backend.** New `typescript-symbol-kind.ts`; not yet used by `node-kind.ts` or `extract-children.ts`. (Type + helper, no callsites yet.)
4. **Flip `SymbolDecl.kind` to `{ role, nativeLabel }`.** Change `types.ts`; re-type `nodeKind` to `TypeScriptSymbolKind`; `extract-children.ts` builds the nested object via `roleOf`. JSON data flows through unchanged in code. Build green; commit-1 tests pass. (One logical change: the kind contract flip and all its producers.)
5. **Remove the dead `SymbolKind` union from core.** Delete `SymbolKind` from `types.ts` and its `core/index.ts` export — now unreferenced. (Pure deletion of dead code.)

**Done when.** `pnpm test` / `lint` / `typecheck` / `build` green. `SymbolDecl.kind` is `{ role, nativeLabel }`. `@symnav/core` exports `SymbolRole`, not `SymbolKind`. `overview` `.txt` e2e snapshots byte-identical to Stage 1; the JSON snapshot reflects the nested kind.

---

## Phase 2 — Signatures become numbered line arrays

**Behavior delivered.** A symbol's signature in the IR is an ordered list of single-line strings plus the source line the block starts at, instead of one possibly-multi-line string. The `overview` text renderer prints each signature line with its source line number (`N: text`) under the symbol, tree glyphs applied per line. Multi-line signatures now render correctly across lines. A long signature is capped by line count, not character count.

**Test cases.**

- *`splitSignatureLines` splits a raw string on newlines.* Unit, `packages/core/src/intermediate-representation/split-signature-lines.test.ts` (new). Assertions: a single-line string → one-element array; a `\n`-joined string → one element per line; no element contains `\n`.
- *`capSignatureLines` caps by line count.* Unit, `packages/renderer/src/overview/signature-cap.test.ts` (rewritten). Assertions: a list at/under the cap is returned unchanged; a longer list is truncated to the cap with a final elision-marker element.
- *`extractSignatureSource` dedents continuation lines.* Update `packages/backend-typescript/src/extract/extract-signature-source.test.ts`. Assertion: for a multi-line declaration, line 0 is flush and continuation lines keep only their relative indentation (source-file ambient indentation stripped).
- *Extraction produces `signature: { startLine, lines }`.* Update `extract-children.test.ts` / `extract-file-symbols.test.ts`. Assertions: `decl.signature.startLine === decl.range.startLine`; `decl.signature.lines` is a non-empty `string[]` with no `\n` in any element.
- *Text renderer numbers each signature line.* Update `render-overview-text.test.ts`. Assertions: a single-line signature renders as `${startLine}: ${text}` flush under a top-level symbol; a nested symbol's signature line renders as `${parentPrefix}${continuationGlyph}${startLine}: ${text}`.
- *Text renderer handles a multi-line signature.* New case in `render-overview-text.test.ts` — the multi-line renderer test deferred in Stage 1. Assertion: each line is numbered `startLine + index` and prefixed with the per-line tree glyph; internal indentation preserved.
- *JSON renderer emits the signature object.* Update `render-overview-json.test.ts` — `signature` is `{ startLine, lines }`.
- *e2e snapshots.* Add a fixture file with a genuine multi-line signature to `packages/testing/fixtures/overview-cases/` plus its `.txt` and `.json` expected snapshots. Update every existing `overview` `.txt` snapshot (signature lines gain `N: ` prefixes; the 3-space `SIGNATURE_INDENT` for top-level signatures is removed) and `.json` snapshot (`signatureSource` → `signature`). Level: e2e.

**Components.**

```ts
// packages/core/src/intermediate-representation/types.ts
export interface Signature {
  readonly startLine: number;          // 1-based source line of lines[0]
  readonly lines: readonly string[];   // each element single-line, no "\n"
}

export interface SymbolDecl {
  readonly kind: { readonly role: SymbolRole; readonly nativeLabel: string };
  readonly name: string;
  readonly range: LineRange;
  readonly signature: Signature;       // replaces signatureSource
  readonly children: readonly SymbolDecl[];
}
```

```ts
// packages/core/src/intermediate-representation/split-signature-lines.ts  (new)
export function splitSignatureLines(raw: string): string[];
```

```ts
// packages/renderer/src/overview/signature-cap.ts
export const SIGNATURE_CAP_LINES = 6;   // proposed; tune during execution
export const SIGNATURE_ELLIPSIS = "…";
export function capSignatureLines(lines: readonly string[]): readonly string[];
```

`extractSignatureSource` keeps returning a `string` but dedents continuation lines: line 0 stays flush; lines 1..n have the source file's ambient indentation (the column the declaration sits at) stripped, preserving only indentation relative to the signature. `extract-children.ts` builds `signature: { startLine: range.startLine, lines: splitSignatureLines(extractSignatureSource(node)) }`.

The text renderer drops `SIGNATURE_INDENT`. Each signature line `i` renders as `${prefix}${signature.startLine + i}: ${text}` — `prefix` is empty for a top-level symbol's signature, `parentPrefix + continuationGlyph` for a nested symbol's. `capSignatureLines` is applied to `signature.lines` before numbering.

**Commit plan.**

1. **Rewrite test expectations and add the multi-line fixture.** All test/snapshot updates above; new multi-line fixture file + its expected `.txt`/`.json`. Red commit. (TDD red commit.)
2. **Add `splitSignatureLines` to core.** New file, exported from `core/index.ts`, unused. (Helper-only, no callsites yet.)
3. **Add `capSignatureLines` to the renderer.** Added to `signature-cap.ts` alongside the existing `capSignature`, unused. (Helper-only, no callsites yet.)
4. **Dedent `extractSignatureSource` continuation lines.** Refactor of the existing extractor; output unchanged for the single-line signatures Stage 1 fixtures exercise. (Refactor only — no IR-shape change yet.)
5. **Flip the signature contract.** Replace `SymbolDecl.signatureSource` with `signature: Signature` in `types.ts`; `extract-children.ts` builds the `Signature`; the text renderer switches to per-line numbering via `capSignatureLines` and drops `SIGNATURE_INDENT`; the JSON renderer flows the new shape through. Delete `capSignature` and the old `SIGNATURE_CAP_CHARS`. Build green; commit-1 tests pass. (One logical change: the signature contract flip across producer and consumers.)

**Done when.** `pnpm test` / `lint` / `typecheck` / `build` green. `overview` text output shows numbered signature lines and renders a multi-line signature correctly. `SymbolDecl` carries `signature: Signature`; `signatureSource` and the char-based cap are gone. The Stage 1.5 done-when for #6 supersedes Stage 1's "byte-identical" clause for `overview` text output.

---

## Phase 3 — Ignore rules consolidate behind one module

**Behavior delivered.** All ignore handling lives behind one `WorkspaceIgnore` class with a build step and an `isIgnored` query. The `.git/` rule is stated once, as a single predicate used by both the build walk and the query. The four-file `ignore/` cluster collapses to one file. `IgnoreScope` leaves the `@symnav/core` public surface. Ignore behavior is observably unchanged.

**Test cases.**

- *`WorkspaceIgnore` aggregates `.gitignore` files and answers `isIgnored`.* Unit, `packages/core/src/workspace/ignore/workspace-ignore.test.ts` (new), built over `InMemoryFileSystem`. Assertions (porting the scenarios currently in `core/test/integration/workspace/ignore.test.ts`): root `.gitignore` patterns ignore matching paths; subdirectory `.gitignore` files aggregate; a path not matched by any scope is not ignored.
- *`.git/` is always ignored.* Unit, same file. Assertions: `.git`, `.git/HEAD` → ignored, regardless of `.gitignore` contents.
- *The build walk does not descend into `.git/` or already-ignored directories.* Unit, same file, using a tracking `FileSystem` (the `TrackingFs` pattern already in `ignore.test.ts`). Assertion: `.git/` and ignored directories are never listed/read during `build`.
- *Empty / root path is not ignored.* Unit, same file. Assertion: `""` and `"/"` → not ignored.
- *Workspace ignore behavior unchanged.* The existing `core/test/integration/workspace/ignore.test.ts` continues to pass (it exercises ignore through the workspace) — confirms the consolidation is behavior-preserving.

**Components.**

```ts
// packages/core/src/workspace/ignore/workspace-ignore.ts  (new — replaces the 4-file cluster)
export class WorkspaceIgnore {
  static build(root: string, fs: FileSystem): WorkspaceIgnore;
  isIgnored(relPath: string): boolean;
}
```

Private inside the module: the `IgnoreScope` shape (`{ dirRelToRoot, matcher }`), the recursive `.gitignore` walk, the scope-matching logic, the scope-relative path conversion, and `isGitInternal(relPath): boolean` — the single `.git/` predicate. `WorkspaceIgnore.build` runs the walk (calling `isGitInternal` to skip descending into `.git/`); `isIgnored` short-circuits empty/root, calls `isGitInternal`, then matches against scopes.

`AbstractWorkspace` changes: `resolveDependencies` returns `{ root, fs, ignore: WorkspaceIgnore }` instead of `{ root, fs, scopes }`; the constructor stores a `WorkspaceIgnore`; `isIgnored(relPath)` delegates to `this.ignore.isIgnored(relPath)` (the empty/root and `.git/` checks move out of `AbstractWorkspace` into `WorkspaceIgnore`). `NodeWorkspace` / `InMemoryWorkspace` constructors take `ignore: WorkspaceIgnore` in place of `scopes`.

**Commit plan.**

1. **Add `WorkspaceIgnore` unit tests.** New `workspace-ignore.test.ts` with the scenarios above. Red commit — class does not exist. (TDD red commit.)
2. **Add the `WorkspaceIgnore` class.** New `workspace-ignore.ts` consolidating the build walk, scope matching, path-relative conversion, and the `isGitInternal` predicate. The four old files still exist and remain in use by `AbstractWorkspace`. Commit-1 tests pass. (Pure addition; no consumer rewired yet.)
3. **Switch the workspace onto `WorkspaceIgnore`.** `AbstractWorkspace.resolveDependencies` builds a `WorkspaceIgnore`; the constructor and `isIgnored` use it; `NodeWorkspace` / `InMemoryWorkspace` constructors take `ignore`. (Refactor only — no behavior change.)
4. **Delete the dead ignore cluster and its export.** Remove `build-scopes.ts`, `scope.ts`, `is-ignored.ts`, `path-relative.ts`, and the `IgnoreScope` export from `core/index.ts` — all now unused. (Pure deletion of dead code.)

**Done when.** `pnpm test` / `lint` / `typecheck` / `build` green. `ignore/` contains a single `workspace-ignore.ts` (+ its test). The `.git/` rule exists in exactly one predicate. `@symnav/core` no longer exports `IgnoreScope`. Ignore behavior unchanged.

---

## Phase 4 — Workspace construction collapses to a factory

**Behavior delivered.** A single `createWorkspace({ startDir, fs })` async factory replaces the `Workspace` interface's abstract base and its two zero-override subclasses. `fs` is always injected. The `Workspace` interface stays; the implementing class is unexported. `@symnav/core` stops exporting `AbstractWorkspace` / `NodeWorkspace` / `InMemoryWorkspace`. `InMemoryFileSystem` stays exported (test code in other packages uses it).

**Test cases.**

- *`createWorkspace` resolves a workspace from a `.git` ancestor.* Integration, `packages/core/test/integration/workspace/` — built over `InMemoryFileSystem`. Assertions: `workspace.root` is the nearest `.git` ancestor of `startDir`; `toAbsolute` / `isInWorkspace` / `isIgnored` behave as before.
- *`createWorkspace` rejects when no `.git` is found.* Integration, same area (ports the lone `InMemoryWorkspace` test from `in-memory.test.ts`). Assertion: rejects with `NotInWorkspaceError`.
- *Existing workspace integration tests migrate.* `core/test/integration/workspace/{ignore,paths,root,fs}.test.ts`, `apps/cli/test/integration/commands/overview/{run-overview,overview-command}.test.ts`, `backend-typescript/test/integration/typescript-backend.test.ts` — every `NodeWorkspace.create` / `InMemoryWorkspace.create` call site becomes `createWorkspace({ startDir, fs: new InMemoryFileSystem(files) })` (or `new NodeFileSystem()`). Assertions unchanged.
- *`InMemoryFileSystem` unit tests stay.* The `InMemoryFileSystem` block of `in-memory.test.ts` is preserved (file renamed to `in-memory-file-system.test.ts`); the `InMemoryWorkspace` block is removed (covered by the `createWorkspace` integration test above).

**Components.**

```ts
// packages/core/src/workspace/workspace.ts
export interface Workspace {
  readonly root: string;
  readonly fs: FileSystem;
  toRelative(absPath: string): string;
  toAbsolute(relPath: string): string;
  isInWorkspace(absPath: string): boolean;
  isIgnored(relPath: string): boolean;
}

export function createWorkspace(opts: {
  startDir: string;
  fs: FileSystem;
}): Promise<Workspace>;
```

The implementing class is declared unexported in `workspace.ts`, with a plain `(root: string, fs: FileSystem, ignore: WorkspaceIgnore)` constructor and the four interface methods (bodies lifted from `AbstractWorkspace`). `createWorkspace` inlines what `AbstractWorkspace.resolveDependencies` did: `posixify` the `startDir`, `findWorkspaceRoot`, throw `NotInWorkspaceError` on `null`, `WorkspaceIgnore.build`, then construct the class.

CLI: `run-overview-action.ts` calls `createWorkspace({ startDir: cwd, fs: args.dependencies.fs ?? new NodeFileSystem() })` and types the local as `Workspace`, replacing the `NodeWorkspace.create` undefined-`fs` branch.

**Commit plan.**

1. **Migrate test call sites to `createWorkspace`.** All test files above switched from `NodeWorkspace.create` / `InMemoryWorkspace.create` to `createWorkspace`; rename `in-memory.test.ts` → `in-memory-file-system.test.ts` dropping the `InMemoryWorkspace` block. Red commit — `createWorkspace` does not exist. (TDD red commit.)
2. **Add `createWorkspace` and the unexported impl class.** New code in `workspace.ts`; `AbstractWorkspace` / `NodeWorkspace` / `InMemoryWorkspace` still exist. Commit-1 tests pass. (Pure addition; no production consumer rewired yet.)
3. **Switch the CLI to `createWorkspace`.** `run-overview-action.ts` uses the factory and the `Workspace` type. (Single production consumer rewired.)
4. **Delete the abstract base, subclasses, and `compute-dir-set.ts`.** Remove `abstract-workspace.ts`, `node-workspace.ts`, `in-memory-workspace.ts`, `compute-dir-set.ts`, and their `core/index.ts` exports — all now unused. (Pure deletion of dead code.)

**Done when.** `pnpm test` / `lint` / `typecheck` / `build` green (including `meta-tests/`). Workspaces are built only via `createWorkspace`. `@symnav/core` exports `createWorkspace`, `Workspace`, `FileSystem`, `NodeFileSystem`, `InMemoryFileSystem` — not `AbstractWorkspace` / `NodeWorkspace` / `InMemoryWorkspace`.

---

## Phase 5 — Self-rendering errors

**Behavior delivered.** Error types carry their user-facing context at construction and expose a `reason` getter. The CLI's per-type `instanceof` ladder and the overloaded `formatUserError` collapse to a single `instanceof UserFacingError` dispatch. `BackendError` is gone; the path/file errors are relocated next to the workspace that throws them. User-visible error messages are byte-identical to Stage 1.

**Test cases.**

- *Each error renders its reason.* Unit, `packages/core/src/workspace/errors.test.ts` and `packages/core/src/backend/errors.test.ts` (new/updated). Assertions: `new FileNotFoundError("foo.ts").reason` === `file not found: foo.ts`; `new OutsideWorkspaceError("foo.ts", "/repo").reason` === `foo.ts is outside the workspace rooted at /repo`; `new IgnoredFileError("foo.ts").reason` === `foo.ts is ignored by .gitignore`; `new UnsupportedFileError("foo.md").reason` === `cannot read .md files (foo.md)`; `new NotInWorkspaceError("/x").reason` === `not in a git workspace (no .git found in or above /x)`. Each is a `UserFacingError`.
- *CLI renders any `UserFacingError` uniformly.* Update `apps/cli/test/integration/commands/overview/overview-command.test.ts` — assertions: a thrown `UserFacingError` is written to stderr as `Cannot answer: ${err.reason}.` with exit code 1; a non-`UserFacingError` exits 2.
- *Delete `format-user-error.test.ts`* — the formatter it covers is removed.
- *e2e `.err` snapshots unchanged.* The `reason` strings are chosen so `Cannot answer: ${reason}.` reproduces the existing `*.expected.err` snapshots byte-for-byte; those e2e tests pass untouched.

**Components.**

```ts
// packages/core/src/errors.ts  (new — cross-cutting base)
export abstract class UserFacingError extends Error {
  abstract get reason(): string;
}
```

```ts
// packages/core/src/workspace/errors.ts  (FileNotFound/Ignored/OutsideWorkspace relocated here)
export class FileNotFoundError extends UserFacingError {
  constructor(inputPath: string);
  get reason(): string;
}
export class IgnoredFileError extends UserFacingError {
  constructor(inputPath: string);
  get reason(): string;
}
export class OutsideWorkspaceError extends UserFacingError {
  constructor(inputPath: string, workspaceRoot: string);
  get reason(): string;
}
export class NotInWorkspaceError extends UserFacingError {
  constructor(startDir: string);
  get reason(): string;
}
```

```ts
// packages/core/src/backend/errors.ts  (BackendError deleted)
export class UnsupportedFileError extends UserFacingError {
  constructor(inputPath: string);
  get reason(): string;       // uses node:path extname, as formatUserError did
}
```

Throw sites gain context: `run-overview.ts` passes `inputPath` (and `workspace.root` for `OutsideWorkspaceError`); `typescript-backend.ts` passes its `filePath` and `this.workspace.root`. `run-overview-action.ts`'s two catch blocks each become `if (err instanceof UserFacingError) { context.stderr.write(\`Cannot answer: ${err.reason}.\n\`); context.exit(1); return; }` then the unexpected-error fallthrough.

`@symnav/core` export changes: add `UserFacingError`; keep `FileNotFoundError`, `OutsideWorkspaceError`, `UnsupportedFileError` (constructed by the untouched TS backend / by the CLI command); drop `BackendError`; drop `NotInWorkspaceError` (no longer referenced by name outside core once the ladder collapses). `IgnoredFileError` stays exported in this phase — `run-overview.ts` still constructs it until Phase 6.

**Commit plan.**

1. **Rewrite error tests for the `reason` contract.** Add/update `errors.test.ts` files; update `overview-command.test.ts`; delete `format-user-error.test.ts`. Red commit. (TDD red commit.)
2. **Add the `UserFacingError` base.** New `core/src/errors.ts`, exported from `core/index.ts`, unused. (Type-only, no callsites yet.)
3. **Relocate the path/file errors.** Move `FileNotFoundError`, `IgnoredFileError`, `OutsideWorkspaceError` from `backend/errors.ts` to `workspace/errors.ts`; fix imports across core / CLI / backend and the `core/index.ts` re-export paths. No content change. (Pure move, no edits.)
4. **Give errors context constructors and `reason`; delete `BackendError`.** All five errors extend `UserFacingError` with context constructors and `reason` getters; throw sites in `run-overview.ts` and `typescript-backend.ts` pass context; `BackendError` deleted and dropped from `core/index.ts`. (One logical change: the error contract becomes self-rendering.)
5. **Collapse CLI error dispatch.** `run-overview-action.ts` catches `UserFacingError` generically; delete `error-output/format-user-error.ts`; drop `NotInWorkspaceError` from `core/index.ts`. (One logical change: the dispatch ladder and the formatter it drove are replaced together.)

**Done when.** `pnpm test` / `lint` / `typecheck` / `build` green. `e2e` `.err` snapshots byte-identical to Stage 1. The CLI has no per-error-type branching. `@symnav/core` exports `UserFacingError`, `FileNotFoundError`, `OutsideWorkspaceError`, `UnsupportedFileError`; not `BackendError` or `NotInWorkspaceError`.

---

## Phase 6 — Workspace-owned input-path resolution

**Behavior delivered.** The resolve-relative / file-exists / inside-workspace / not-ignored sequence is one `Workspace.resolveInputPath(inputPath, fromDir)` call that returns a workspace-relative path or throws a self-rendering error. The `overview` command starts from that one call instead of re-implementing the policy. `toRelative` and `isIgnored` leave the `Workspace` interface; `IgnoredFileError` leaves the `@symnav/core` public surface.

**Test cases.**

- *`resolveInputPath` resolves and validates.* Integration, `packages/core/test/integration/workspace/` — over `InMemoryFileSystem`. Assertions: a relative `inputPath` is resolved against `fromDir` and returned as a workspace-relative POSIX path; an absolute `inputPath` inside the workspace is returned workspace-relative; a missing file throws `FileNotFoundError`; a path outside the workspace throws `OutsideWorkspaceError`; a `.gitignore`-matched path throws `IgnoredFileError`.
- *`overview` command behavior unchanged.* Update `apps/cli/test/integration/commands/overview/run-overview.test.ts` — assertions on the same scenarios, now routed through `resolveInputPath`.
- *e2e snapshots unchanged.* All `overview` e2e tests (`.txt`, `.json`, `.err`) pass untouched — confirms the path-resolution move is behavior-preserving.

**Components.**

```ts
// packages/core/src/workspace/workspace.ts
export interface Workspace {
  readonly root: string;
  readonly fs: FileSystem;
  toAbsolute(relPath: string): string;
  isInWorkspace(absPath: string): boolean;
  resolveInputPath(inputPath: string, fromDir: string): Promise<string>;
}
```

`toRelative` and `isIgnored` are removed from the interface and become private methods on the impl class (still used internally by `resolveInputPath`). The impl class's `resolveInputPath`: `isAbsolute(inputPath) ? inputPath : resolve(fromDir, inputPath)` (via `node:path`); `await this.fs.exists(...)` → `FileNotFoundError`; `isInWorkspace(...)` → `OutsideWorkspaceError`; `toRelative(...)`; `isIgnored(...)` → `IgnoredFileError`; return the relative path.

`run-overview.ts` collapses to: `const relativePath = await workspace.resolveInputPath(inputPath, cwd);` then the existing `router.find(relativePath)` → `UnsupportedFileError` and `backend.fileSymbols(relativePath)`.

`@symnav/core` export change: drop `IgnoredFileError` — now thrown only inside `core` and caught generically as `UserFacingError`.

**Commit plan.**

1. **Add `resolveInputPath` tests.** New integration test for the workspace operation; update `run-overview.test.ts`. Red commit — method does not exist. (TDD red commit.)
2. **Add `resolveInputPath` to the interface and impl class.** The four-step policy now lives in the impl class; `run-overview.ts` still runs its own inline copy. (Pure addition; no consumer rewired yet.)
3. **Switch `run-overview.ts` to `resolveInputPath`.** Delete the inline resolve/exists/inside/ignored sequence; call the workspace operation. (Caller switched, dead inline policy deleted.)
4. **Trim the now-internal surface.** Remove `toRelative` and `isIgnored` from the `Workspace` interface (private on the impl class); drop `IgnoredFileError` from `core/index.ts`. (One logical change: surface subsumed by `resolveInputPath` goes internal.)

**Done when.** `pnpm test` / `lint` / `typecheck` / `build` green. `overview`'s path handling is a single `resolveInputPath` call. `Workspace` exposes `root`, `fs`, `toAbsolute`, `isInWorkspace`, `resolveInputPath`. `@symnav/core` no longer exports `IgnoredFileError`.

---

## Phase 7 — Shared command pipeline

**Behavior delivered.** Workspace lifecycle, backend/router construction, error dispatch, renderer selection, output-stream writing, and exit-code policy live in one `runCommand` seam. A command supplies only a `compute` function and a renderer pair. The `overview` command is reduced to an `OverviewCommand` definition; `run-overview-action.ts` and `run-overview.ts` are gone.

**Test cases.**

- *`runCommand` drives the lifecycle.* Integration, `apps/cli/test/integration/` — using `fake-program-context.ts` and `fake-language-backend.ts`. Assertions: workspace-creation failure (`NotInWorkspaceError`) → `Cannot answer: …` on stderr, exit 1; a `compute` that throws `UserFacingError` → stderr + exit 1; a `compute` that throws anything else → raw message on stderr, exit 2; `json: true` selects `renderJson`, `json: false` selects `renderText`; the rendered string is written to stdout on success.
- *`OverviewCommand.compute` produces `FileSymbols`.* Integration — assertions: `compute` resolves the input path, routes to a backend, returns the backend's `FileSymbols`; an unroutable extension throws `UnsupportedFileError`.
- *`overview` end-to-end unchanged.* All `overview` e2e tests pass untouched — confirms the pipeline extraction is behavior-preserving.

**Components.**

```ts
// apps/cli/src/command.ts  (new)
export interface CommandContext {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
}

export interface CommandInvocation {
  context: ProgramContext;
  dependencies: ProgramDependencies;
  cwdOverride: string | undefined;
  json: boolean;
}

export abstract class Command<Result> {
  abstract compute(ctx: CommandContext): Promise<Result>;
  abstract renderText(result: Result): string;
  abstract renderJson(result: Result): string;
}

export function runCommand<Result>(
  command: Command<Result>,
  invocation: CommandInvocation,
): Promise<void>;
```

```ts
// apps/cli/src/commands/overview/overview-command.ts  (new)
export class OverviewCommand extends Command<FileSymbols> {
  constructor(file: string);
  compute(ctx: CommandContext): Promise<FileSymbols>;
  renderText(result: FileSymbols): string;   // delegates to renderOverviewText
  renderJson(result: FileSymbols): string;   // delegates to renderOverviewJson
}
```

`runCommand`: `cwd = cwdOverride ?? context.cwd`; in one `try`, `createWorkspace({ startDir: cwd, fs: dependencies.fs ?? new NodeFileSystem() })`, build `backends = dependencies.backends?.(workspace) ?? [new TypeScriptBackend(workspace)]`, `router = new BackendRouter(backends)`, `result = await command.compute({ workspace, router, cwd })`; one `catch` — `UserFacingError` → `Cannot answer: ${err.reason}.` + exit 1, otherwise raw message + exit 2; on success, `(json ? command.renderJson : command.renderText)(result)` written to `context.stdout`.

`OverviewCommand.compute` absorbs `run-overview.ts`: `resolveInputPath` → `router.find` → `UnsupportedFileError` → `backend.fileSymbols`.

`register-overview-command.ts`'s `.action` becomes `await runCommand(new OverviewCommand(file), { context, dependencies, cwdOverride, json: options.json })`.

*Naming note.* Commander already exports a type named `Command`, imported in `program.ts` and `register-overview-command.ts`. The new abstract class is also `Command`; the Commander import in those two files must be aliased (e.g. `import type { Command as CommanderCommand }`) to avoid the collision.

**Commit plan.**

1. **Add pipeline tests.** Integration tests for `runCommand` and `OverviewCommand.compute`; update `overview-command.test.ts`. Red commit — `runCommand` / `OverviewCommand` do not exist. (TDD red commit.)
2. **Add the `Command` abstraction and `runCommand`.** New `apps/cli/src/command.ts` with `Command`, `CommandContext`, `CommandInvocation`, `runCommand`; unused. (Types + seam, no callsites yet.)
3. **Add `OverviewCommand`.** New `overview-command.ts` extending `Command`, absorbing `run-overview.ts`'s logic; not yet wired into registration. (Uses the abstraction from commit 2; no caller yet.)
4. **Wire registration and delete the old action.** `register-overview-command.ts` calls `runCommand(new OverviewCommand(...))`; alias the Commander `Command` import; delete `run-overview-action.ts` and `run-overview.ts`. (Caller switched, dead code deleted.)

**Done when.** `pnpm test` / `lint` / `typecheck` / `build` green. The `overview` e2e suite passes unchanged. Command lifecycle exists once, in `runCommand`. A Stage 2 command can be added by writing a `Command` subclass and a registration line — no lifecycle, error-dispatch, or renderer-selection code re-derived.

---

## Out of scope

- **New commands.** `resolve`, `def`, `refs`, `context`, `graph` — Stages 2–5. This plan only hardens the seams they will reuse.
- **TypeScript backend cleanup.** The backend's own `isInWorkspace` / existence checks in `fileSymbols` / `loadSourceFile` are deliberately left untouched (drill-down decision); they stay as a public-package-boundary guard.
- **Consumers of `SymbolRole`.** Phase 1 adds the role; nothing branches on it yet. The first real consumer is a Stage 2 command (`def`'s kind-tagged tree).
- **New language backends.** Phase 1 makes `@symnav/core` backend-agnostic for symbol kinds, but adds no backend — see "Beyond V1" in the stages doc.
- **`@symnav/testing` changes.** Nothing moves into the testing package; `InMemoryFileSystem` stays in `@symnav/core`.
- **Daemon / persistent process.** Unchanged from the stages doc — a future wrapper over the now-consolidated command logic.
