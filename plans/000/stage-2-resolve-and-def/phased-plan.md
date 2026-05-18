# Stage 2 — `resolve` and `def`: phased implementation plan

Detailed plan for delivering Stage 2 of [`plans/000/symnav-stages.md`](../symnav-stages.md): the `symnav resolve` and `symnav def` commands, plus the supporting infrastructure they share.

## Goal

After this plan lands, two new CLI surfaces work end-to-end:

- `symnav resolve <query> [--fuzzy] [--json]` — finds matching symbols across the workspace (in two sections: symbols, then files whose name matches but contain no matching symbols), with case-sensitive equality by default and fzf-style case-insensitive subsequence matching under `--fuzzy`.
- `symnav def <symbol-id> [--json]` — accepts a canonical symbol ID and prints every definition the backend produces: overloads, declarations, the implementation, plus implementations of interface/abstract contracts across the workspace.

Under the hood, the project gains: a single canonical `SymbolIdentity` type and codec that owns the ID string grammar; per-symbol numeric disambiguators on collisions; a workspace-wide file enumeration primitive; a slimmer command pipeline that no longer assumes every command operates on one file; and two new backend methods (`resolveSymbols`, `findDefinitions`) that handle workspace-scoped semantic work.

## Context

The codebase today reflects Stage 1.5's consolidation pass. Relevant surface:

- **`@symnav/core`**
  - IR (`packages/core/src/intermediate-representation/`): `SymbolDecl`, `FileSymbols`, `SymbolKind`, `SymbolRole`, `Signature`, `LineRange`, plus the helpers `buildSymbolPath` and `splitSignatureLines`.
  - Workspace (`packages/core/src/workspace/`): `Workspace` interface with one method (`resolveInputPath`), built by `createWorkspace({ startDir, fs })`. `WorkspaceIgnore` consolidates `.gitignore`/`.git/` handling. `FileSystem` port exposes `readFile`, `exists`, `existsSync`, `readFileSync`, `listDirSync`, `isDirectorySync`.
  - Backend (`packages/core/src/backend/`): `LanguageBackend` interface with `accepts` and `fileSymbols`; `BackendRouter.find(filePath)` returns the first accepting backend or `undefined`; `UnsupportedFileError` is thrown by the CLI when no backend accepts.
  - Self-rendering errors (`packages/core/src/errors.ts`, `packages/core/src/workspace/errors.ts`): `UserFacingError` base class plus `FileNotFoundError`, `OutsideWorkspaceError`, `NotInWorkspaceError`, `IgnoredFileError`.
- **`@symnav/backend-typescript`**: `TypeScriptBackend` (one method beyond `accepts`: `fileSymbols`). Symbol extraction lives in `packages/backend-typescript/src/extract/` (`extract-file-symbols.ts`, `extract-children.ts`, `node-kind.ts`, `typescript-symbol-kind.ts`, `extract-signature-source.ts`).
- **`@symnav/renderer`**: `renderOverviewText` and `renderOverviewJson`, with private helpers under `packages/renderer/src/overview/`.
- **`apps/cli`**: `runCommand` in `command.ts` owns workspace creation, file resolution, backend selection, error dispatch, output stream, exit-code, and json/text dispatch. `CommandContext` carries `{workspace, router, cwd, args, path, backend}`. Today the `Command` interface assumes every command operates on a single file (`args.file`, `path: ResolvedPath`). The only registered command is `overview`.
- **`@symnav/testing`** (`packages/testing/`): `fixturePath`, fixture loader, the `dot-git` → `.git` rename helper for fixtures with a synthetic git root. Fixtures live under `packages/testing/fixtures/`.
- **Tests**: Vitest. Unit tests colocate with sources (`*.test.ts`). Integration under `<package>/test/integration/`. E2E under `apps/cli/test/e2e/` and spawn the built binary.

What this plan reuses without changing: `SymbolKind`/`SymbolRole`/`Signature`/`LineRange`, `WorkspaceIgnore`, `FileSystem` port, error infrastructure, fixture conventions, the `runCommand`'s error/output/exit-code/render-dispatch logic.

What this plan reshapes or adds:
- `SymbolDecl` gains a composed `identity` field (file + path of segments with optional disambiguator). `FileSymbols` is renamed to `OverviewFileSymbols`.
- New canonical-ID codec (`parseSymbolIdentity` / `formatSymbolIdentity`) lives in core.
- `Workspace` gains `enumerate()`. `BackendRouter` gains `findOrThrow`.
- `runCommand` slims down: it stops resolving file paths and routing to backends; each command does that itself in `compute`. `CommandContext` drops `path` and `backend`.
- `LanguageBackend` gains `resolveSymbols(files, query, opts)` and `findDefinitions(files, identity)`.
- TypeScript backend implements both new methods using ts-morph's whole-Project semantic analysis.
- New renderer surfaces for resolve and def, mirroring the overview structure.
- New CLI commands `resolve` and `def`.

## Phase 1 — Canonical identity types and codec

**Behavior delivered.** `SymbolDecl` carries a composed `SymbolIdentity` that uniquely addresses a symbol in the workspace, with numeric disambiguators applied when names collide in scope. A single codec in `@symnav/core` parses and formats canonical-ID strings. `overview` produces byte-identical output to before for all existing fixtures; the structural change is internal.

### Test cases (TDD-first)

| Test | Assertion | Level | Fixture / setup |
|---|---|---|---|
| `parseSymbolIdentity` parses `src/foo.ts::Bar::baz` | Returns `{file: "src/foo.ts", path: [{name: "Bar"}, {name: "baz"}]}` | unit | none |
| `parseSymbolIdentity` parses leaf disambiguator `src/foo.ts::Bar::baz#2` | Returns `{file: "src/foo.ts", path: [{name: "Bar"}, {name: "baz", disambiguator: 2}]}` | unit | none |
| `parseSymbolIdentity` parses ancestor disambiguator `src/foo.ts::Bar#1::baz` | Returns identity with `disambiguator: 1` on the ancestor segment | unit | none |
| `parseSymbolIdentity` parses single-segment ID `src/foo.ts::topLevel` | Returns `{file: "src/foo.ts", path: [{name: "topLevel"}]}` | unit | none |
| `parseSymbolIdentity` rejects empty input | Throws a self-rendering error | unit | none |
| `parseSymbolIdentity` rejects missing `::` separator | Throws | unit | none |
| `parseSymbolIdentity` rejects empty segment | Throws (`a::::b`, `a::b::`) | unit | none |
| `parseSymbolIdentity` rejects non-positive disambiguator | Throws (`a::b#0`, `a::b#-1`, `a::b#abc`) | unit | none |
| `formatSymbolIdentity` formats no-disambiguator identity | Produces `src/foo.ts::Bar::baz` | unit | none |
| `formatSymbolIdentity` formats leaf disambiguator | Produces `src/foo.ts::Bar::baz#2` | unit | none |
| `formatSymbolIdentity` formats ancestor disambiguator | Produces `src/foo.ts::Bar#1::baz` | unit | none |
| Codec round-trips | `formatSymbolIdentity(parseSymbolIdentity(s)) === s` for all valid inputs above | unit | none |
| TypeScript backend assigns no disambiguator when name is unique in scope | `SymbolDecl.identity.path[*].disambiguator` is undefined | unit | small fixture: one class with non-colliding method names |
| TypeScript backend assigns sequential `#1, #2, …` to colliding overloads in source order | First overload signature gets `#1`, second `#2`, implementation `#3` | unit | fixture: class with `Router.post` (two overloads + implementation) |
| TypeScript backend assigns `#1`/`#2` to static-vs-instance collision | Static gets `#1` (first in source order), instance `#2` | unit | fixture: class with `static bar()` and `bar()` |
| TypeScript backend assigns `#1`/`#2` to getter-vs-setter collision | Source order | unit | fixture: class with `get bar()` and `set bar(v)` |
| Existing overview fixture snapshots produce byte-identical output | Stage 1 + 1.5 snapshots unchanged | e2e | reuse `overview-cases` fixture |

### Components

New file `packages/core/src/intermediate-representation/symbol-identity.ts`:

```ts
export interface SymbolPathSegment {
  readonly name: string;
  readonly disambiguator?: number;
}

export interface SymbolIdentity {
  readonly file: string;
  readonly path: readonly SymbolPathSegment[];
}
```

Revised `packages/core/src/intermediate-representation/types.ts` (only `SymbolDecl` and `FileSymbols` change shape; `SymbolKind`, `SymbolRole`, `Signature`, `LineRange` are unchanged):

```ts
export interface SymbolDecl {
  readonly identity: SymbolIdentity;
  readonly kind: SymbolKind;
  readonly range: LineRange;
  readonly signature: Signature;
  readonly children: readonly SymbolDecl[];
}

export interface OverviewFileSymbols {
  readonly file: string;
  readonly symbols: readonly SymbolDecl[];
}
```

New file `packages/core/src/intermediate-representation/canonical-identity.ts`:

```ts
export function parseSymbolIdentity(raw: string): SymbolIdentity;
export function formatSymbolIdentity(identity: SymbolIdentity): string;
```

Codec contract:
- The grammar is `<file>::<segment>(::<segment>)*` where `<segment>` is `<name>` or `<name>#<positive-int>`.
- The file portion is everything before the first `::`. POSIX file paths never contain `::`, so this split is unambiguous.
- `formatSymbolIdentity` is the inverse of `parseSymbolIdentity` for any identity produced from a parsed string; round-trip equality holds.
- Parse errors throw a self-rendering error (subclass of `UserFacingError`), distinguishing kinds (`empty input`, `missing separator`, `empty segment`, `invalid disambiguator`).

New error type in `packages/core/src/intermediate-representation/canonical-identity.ts` (or a sibling errors file in the same module):

```ts
export class InvalidSymbolIdError extends UserFacingError {
  constructor(reason: string, raw: string);
}
```

New helper in TypeScript backend, `packages/backend-typescript/src/extract/assign-disambiguators.ts`:

```ts
export function assignDisambiguators(siblings: readonly SymbolDecl[]): readonly SymbolDecl[];
```

Walks each sibling list, groups by `identity.path[-1].name`, and within any group of size ≥ 2 assigns sequential `disambiguator` values in source order (already implied by ts-morph traversal order). Recurses into `children`. Used in `extractFileSymbols` before returning.

Updated `extractFileSymbols` signature stays the same; internally it now constructs full `SymbolIdentity` for each symbol (the file is known at extraction time; the path is built by walking ancestors during recursion).

Updated `@symnav/core` public exports (`packages/core/src/index.ts`):

```ts
export type {
  SymbolPathSegment,
  SymbolIdentity,
  SymbolKind,
  SymbolRole,
  Signature,
  LineRange,
  SymbolDecl,
  OverviewFileSymbols,
} from "./intermediate-representation/...";
export { parseSymbolIdentity, formatSymbolIdentity } from "./intermediate-representation/canonical-identity.js";
export { InvalidSymbolIdError } from "./intermediate-representation/canonical-identity.js";
// (FileSymbols export removed; OverviewFileSymbols replaces it.)
```

### Commit plan

1. **Add `SymbolPathSegment` and `SymbolIdentity` types.** Type-only file `symbol-identity.ts`; no callsites yet. Type-only commit; reviewers see the shape on its own. *(Hygiene: type-only, no use.)*
2. **Add canonical-ID codec tests (failing).** Add `canonical-identity.test.ts` covering parse, format, round-trip, and error cases. *(Hygiene: tests-first.)*
3. **Add canonical-ID codec implementation.** Add `canonical-identity.ts` with `parseSymbolIdentity`, `formatSymbolIdentity`, and `InvalidSymbolIdError`. Tests from previous commit go green. *(Hygiene: implementation follows tests.)*
4. **Add `assignDisambiguators` tests (failing).** Test file in `packages/backend-typescript/src/extract/assign-disambiguators.test.ts` covering: unique names (no disambiguators), overload set (sequential), static/instance collision, getter/setter collision, nested-class recursion. *(Hygiene: tests-first.)*
5. **Add `assignDisambiguators` helper.** Pure function; not yet wired into `extractFileSymbols`. *(Hygiene: type-only addition; no callsites yet.)*
6. **Restructure `SymbolDecl` to compose `SymbolIdentity`; rename `FileSymbols` to `OverviewFileSymbols`.** Update `types.ts`. Update `extractFileSymbols` to produce the new shape (no disambiguator assignment yet — every `disambiguator` stays undefined). Update renderer to read `decl.identity.path` for symbol-path formatting (in place of `buildSymbolPath`'s ancestor-names approach). Update `buildSymbolPath` to work from the new identity shape or remove it if every callsite migrated. Existing overview snapshot tests remain green (shape change is internal; rendered strings unchanged for already-unique names). *(Hygiene: structural rename + composition only; behavior unchanged.)*
7. **Wire `assignDisambiguators` into `extractFileSymbols`.** Symbols whose names collide in scope now carry `#N` in their identity. Update fixtures and overview snapshots that include collision cases (if any exist — Stage 1's `overview-cases` fixture should be reviewed; new collision-bearing fixtures may belong here or in later phases). *(Hygiene: one logical change — disambiguator assignment becomes active.)*
8. **Update public exports.** Adjust `packages/core/src/index.ts` to publish the new types and remove `FileSymbols`. Adjust dependents' imports across the workspace. *(Hygiene: export-surface change only.)*

### Done when

- All new unit tests pass.
- All existing overview e2e and snapshot tests pass byte-identically for fixtures without name collisions.
- For fixtures with name collisions (added in commit 7 if needed), symbols carry sequential `#N` in their identity.
- `pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint && pnpm typecheck` is green.

---

## Phase 2 — Workspace enumeration, router throw-helper, and pipeline reshape

**Behavior delivered.** `Workspace.enumerate()` returns all non-ignored workspace files as `ResolvedPath[]`. `BackendRouter.findOrThrow(path)` collapses the "find + throw `UnsupportedFileError`" pair. The command pipeline (`runCommand`) no longer resolves files or selects backends; each command does that itself. `CommandContext` slims to `{workspace, router, cwd, args}`. `overview` behaves identically to before but now does its own file resolution and backend selection inside `compute`.

### Test cases (TDD-first)

| Test | Assertion | Level | Fixture / setup |
|---|---|---|---|
| `Workspace.enumerate` lists every non-ignored file under root | Returns all `.ts` and other files in expected workspace-relative POSIX form | unit | new fixture: `enumerate-cases` with nested dirs and a few file types |
| `Workspace.enumerate` skips `.gitignore`-ignored files | Ignored files not in result | unit | fixture includes `.gitignore` entries |
| `Workspace.enumerate` skips `.git/` | `.git/HEAD` etc. not in result | unit | reuse fixture |
| `Workspace.enumerate` returns paths sorted deterministically | Same workspace state → same order on every call | unit | reuse fixture |
| `BackendRouter.findOrThrow` returns the accepting backend | Same as `find` for accepted paths | unit | existing router tests setup |
| `BackendRouter.findOrThrow` throws `UnsupportedFileError` when no backend accepts | Error includes the file path | unit | router with no matching backend |
| `runCommand` calls `compute` with slimmed `CommandContext` | No `path` or `backend` fields present; `workspace`, `router`, `cwd`, `args` are passed through | unit | mock command |
| `runCommand` still routes `UserFacingError` to stderr with `Cannot answer:` prefix and exit 1 | Existing behavior preserved | unit | mock command throwing self-rendering error |
| `runCommand` still routes unexpected errors to stderr with exit 2 | Existing behavior preserved | unit | mock command throwing plain `Error` |
| All existing `overview` e2e tests pass | Behavior unchanged | e2e | existing fixtures |

### Components

Updated `packages/core/src/workspace/workspace.ts`:

```ts
export interface Workspace {
  readonly root: string;
  resolveInputPath(inputPath: string, cwd: string): Promise<ResolvedPath>;
  enumerate(): Promise<readonly ResolvedPath[]>;
}
```

The implementation walks from `root` using `FileSystem`'s existing `listDirSync` / `isDirectorySync`, filtering through `WorkspaceIgnore`. Returns `ResolvedPath` records sorted by `relative` (POSIX) to guarantee stability.

Updated `packages/core/src/backend/backend-router.ts`:

```ts
export class BackendRouter {
  find(filePath: string): LanguageBackend | undefined;
  findOrThrow(filePath: string): LanguageBackend; // throws UnsupportedFileError
}
```

Updated `apps/cli/src/command.ts`:

```ts
export interface CommandContext<Args> {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly args: Args;
}

export interface Command<Result, Args> {
  compute(ctx: CommandContext<Args>): Promise<Result>;
  renderText(result: Result): string;
  renderJson(result: Result): string;
}

export interface CommandInvocation<Args> {
  readonly context: ProgramContext;
  readonly dependencies: ProgramDependencies;
  readonly cwdOverride: string | undefined;
  readonly json: boolean;
  readonly args: Args;
}

export function runCommand<Result, Args>(
  command: Command<Result, Args>,
  invocation: CommandInvocation<Args>,
): Promise<void>;
```

`CommandArgs` (the old `{file: string}` base) goes away; commands declare their own `Args`.

Updated `apps/cli/src/commands/overview/overview-command.ts`:

```ts
export interface OverviewArgs {
  readonly file: string;
}

export const overviewCommand: Command<OverviewFileSymbols, OverviewArgs> = {
  async compute(ctx) {
    const path = await ctx.workspace.resolveInputPath(ctx.args.file, ctx.cwd);
    const backend = ctx.router.findOrThrow(path.relative);
    return backend.fileSymbols(path);
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};
```

### Commit plan

1. **Add `Workspace.enumerate` tests (failing).** Add `enumerate-cases` fixture and tests. *(Hygiene: tests-first; fixtures count as test infrastructure.)*
2. **Implement `Workspace.enumerate`.** Tests go green. *(Hygiene: implementation follows tests.)*
3. **Add `BackendRouter.findOrThrow` tests (failing) and implementation in one commit.** Trivial enough that splitting tests from impl adds no review value; both fit on a screen. *(Hygiene: tests-first within the commit; one logical addition.)*
4. **Slim `CommandContext` and `runCommand`; move file resolution + backend selection out of the pipeline.** Drop `path` and `backend` from context; remove the `CommandArgs` base. `runCommand` now only handles workspace creation, error dispatch, output, exit-code, and json/text dispatch. *(Hygiene: refactor only — no behavior change visible at the CLI.)*
5. **Migrate `overview` command to do its own file resolution and backend selection.** `overview-command.ts` calls `workspace.resolveInputPath` and `router.findOrThrow` inside `compute`. Existing overview e2e tests stay green. *(Hygiene: one logical change — the consumer adopts the new context shape.)*

### Done when

- All new unit tests pass.
- All existing overview e2e tests pass byte-identically.
- `CommandContext` no longer carries `path` or `backend`.
- Full CI-parity sequence green.

---

## Phase 3 — Backend interface extensions (stubs)

**Behavior delivered.** `LanguageBackend` declares `resolveSymbols` and `findDefinitions`. The TypeScript backend has stub implementations that throw `Error("not implemented")`. No CLI behavior changes. This phase exists to land the interface change as a reviewable unit before the implementations.

### Test cases (TDD-first)

| Test | Assertion | Level | Fixture / setup |
|---|---|---|---|
| `LanguageBackend` interface compiles with stubs | TypeScript build passes | typecheck | n/a |
| `TypeScriptBackend.resolveSymbols` throws not-implemented | Calling it raises `Error("not implemented")` | unit | none |
| `TypeScriptBackend.findDefinitions` throws not-implemented | Same | unit | none |
| Existing `overview` e2e tests pass | Behavior unchanged | e2e | existing fixtures |

### Components

Updated `packages/core/src/backend/language-backend.ts`:

```ts
export interface ResolveSymbolsOptions {
  readonly fuzzy: boolean;
}

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileSymbols(path: ResolvedPath): Promise<OverviewFileSymbols>;
  resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolDecl[]>;
  findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolDecl[]>;
}
```

Updated `packages/backend-typescript/src/typescript-backend/typescript-backend.ts`: add stub methods that throw.

### Commit plan

1. **Add `ResolveSymbolsOptions` type.** Type-only addition in the backend interface module. *(Hygiene: type-only, no use.)*
2. **Extend `LanguageBackend` with `resolveSymbols` and `findDefinitions`; add throwing stubs to `TypeScriptBackend`.** Necessary together: extending the interface without the stubs breaks the build. *(Hygiene: one logical change — interface widens, only implementor satisfies it minimally.)*
3. **Add unit tests asserting the stubs throw.** Locks in the not-implemented contract so accidental partial implementations are caught. *(Hygiene: tests-only; stubs already in place.)*

### Done when

- Interface compiles with both methods declared.
- Stubs throw as expected.
- All existing tests pass.

---

## Phase 4 — `resolve` command

**Behavior delivered.** `symnav resolve <query>` and `symnav resolve --fuzzy <query>` work end-to-end against the TypeScript backend. Output matches the functional spec's `resolve` format (with the Files section non-overlapping with the Symbols section per the drill-down decision). `--json` produces structured output.

### Test cases (TDD-first)

| Test | Assertion | Level | Fixture / setup |
|---|---|---|---|
| Exact match returns only symbols with that exact name | One match → one result | unit (backend) | new fixture `resolve-cases` with a few classes and functions |
| Exact match is case-sensitive | `Payment` ≠ `payment` | unit (backend) | reuse fixture |
| Exact match finds matches in nested scopes | Method on a class returned even though it's nested | unit (backend) | reuse fixture |
| Exact match across files surfaces every occurrence | Multiple matching symbols across files all returned | unit (backend) | reuse fixture |
| Fuzzy match is case-insensitive subsequence | `payproc` matches `PaymentProcessor` and similar | unit (backend) | reuse fixture |
| Fuzzy match ranks higher-quality matches first | Consecutive runs and boundary matches rank above scattered | unit (backend) | reuse fixture |
| No match returns empty | `resolve NonExistent` → empty array | unit (backend) | reuse fixture |
| Empty query rejected | Throws a self-rendering error | unit | none |
| Resolve command's `compute` enumerates workspace files, fans out to all backends, merges results | With one backend (TS) and the fixture, result equals direct backend call | integration | reuse fixture |
| Resolve command's `compute` produces the Files section as files matching by basename and not in symbols section | Verified against fixture with one file matching by name only | integration | fixture includes a file like `Payment.ts` containing no `Payment` symbol |
| Renderer text output matches snapshot | Snapshot test | unit | sample `ResolveResult` |
| Renderer JSON output matches snapshot | Snapshot test | unit | sample `ResolveResult` |
| E2E exact `symnav resolve PaymentProcessor` produces expected text | Snapshot | e2e | new fixture under `packages/testing/fixtures/resolve-cases/` |
| E2E fuzzy `symnav resolve --fuzzy payment` produces expected text | Snapshot | e2e | reuse fixture |
| E2E no-match produces empty sections with the header | Snapshot | e2e | reuse fixture |
| E2E `--json` produces parseable JSON matching schema | Parsed and compared to expected object | e2e | reuse fixture |
| Ignored files contribute neither symbols nor file matches | None of the ignored file's content surfaces | e2e | fixture includes `.gitignore`'d file |

### Components

New backend module `packages/backend-typescript/src/resolve/resolve-symbols.ts`:

```ts
export function resolveSymbols(
  files: readonly ResolvedPath[],
  query: string,
  options: ResolveSymbolsOptions,
): Promise<readonly SymbolDecl[]>;
```

Implementation notes (for the implementer, not in the plan):
- Build a `ts-morph Project` over `files`.
- For each source file, run the same extraction used by `fileSymbols` (factor or share the existing extractor — it already produces self-identifying symbols after Phase 1).
- Flatten the tree and apply the name matcher: exact (case-sensitive equality on `identity.path[-1].name`) or fuzzy (case-insensitive subsequence, ranked).
- Use a small fuzzy library (e.g. `fuzzysort`) for `--fuzzy` matching and ranking; pin the version in this package.
- Return matched symbols as-is (each carries its full identity).

New result type and command in `apps/cli/src/commands/resolve/`:

```ts
// resolve-result.ts
export interface ResolveResult {
  readonly query: string;
  readonly fuzzy: boolean;
  readonly symbols: readonly SymbolDecl[];
  readonly files: readonly string[]; // workspace-relative POSIX, sorted, excludes files in symbols
}

// resolve-command.ts
export interface ResolveArgs {
  readonly query: string;
  readonly fuzzy: boolean;
}

export const resolveCommand: Command<ResolveResult, ResolveArgs>;
```

`resolveCommand.compute`:
- Enumerate workspace files via `workspace.enumerate()`.
- Partition: for each backend in `router`, filter to the files it `accepts`.
- Fan out: call `backend.resolveSymbols(slice, query, { fuzzy })` for each backend.
- Merge: concatenate symbol results; sort by `(identity.file, range.startLine)`.
- Compute files-section: filter enumerated files whose basename matches `query` (same rule as symbol match: exact or fuzzy), then exclude any file present in `symbols[*].identity.file`. Sort by relative path.
- Return `ResolveResult`.

New renderer surface `packages/renderer/src/resolve/`:

```ts
// render-resolve-text.ts
export function renderResolveText(result: ResolveResult): string;

// render-resolve-json.ts
export function renderResolveJson(result: ResolveResult): string;
```

New CLI registration `apps/cli/src/commands/resolve/register-resolve-command.ts`:

```ts
export function registerResolveCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void;
```

`program.command("resolve <query>")` with `.option("--fuzzy", ...)` and `.option("--json", ...)`.

### Commit plan

1. **Add `resolve-cases` fixture under `packages/testing/fixtures/`.** Includes a `.gitignore`, a few `.ts` files with overlapping names and one file whose basename matches the query but contains no matching symbols. Include `dot-git/`. *(Hygiene: fixture-only; no code.)*
2. **Add `resolveSymbols` unit tests (failing).** Tests for exact, fuzzy, no-match, case-sensitivity, ranking, cross-file. *(Hygiene: tests-first.)*
3. **Implement `TypeScriptBackend.resolveSymbols`** (replacing the stub). Add `fuzzysort` (or chosen library) to `package.json` of `packages/backend-typescript`. *(Hygiene: implementation follows tests.)*
4. **Add `ResolveResult` type.** Type-only file. *(Hygiene: type-only, no callsites.)*
5. **Add resolve renderer tests (failing).** Text and JSON snapshot tests against synthetic `ResolveResult`. *(Hygiene: tests-first.)*
6. **Implement resolve renderer (text + JSON).** Snapshots go green. *(Hygiene: implementation follows tests.)*
7. **Export resolve renderer from `@symnav/renderer`.** *(Hygiene: export-surface change only.)*
8. **Add `resolveCommand` and `registerResolveCommand`.** Compose backend + renderer. Register in `program.ts`. *(Hygiene: one logical change — the new command appears on the CLI.)*
9. **Add resolve e2e tests.** Exact, fuzzy, no-match, `--json`, ignored-file cases against `resolve-cases` fixture. *(Hygiene: end-to-end verification.)*

### Done when

- `symnav resolve <query>` and `symnav resolve --fuzzy <query>` produce spec-conformant output against the `resolve-cases` fixture.
- Files section contains only basename-matching files with no symbol matches inside.
- `--json` emits parseable structured output.
- Ignored files don't surface.
- Full CI-parity sequence green.

---

## Phase 5 — `def` command (including multi-implementation expansion)

**Behavior delivered.** `symnav def <symbol-id>` works end-to-end. Parses the canonical-ID string, resolves the file portion through the workspace, hands the typed `SymbolIdentity` to the backend, and renders the result. The backend matches the identity (with wildcards on missing disambiguators), expands matches that represent contracts (interface methods, abstract methods, abstract classes) with their implementations across the workspace, and returns the union as self-identifying `SymbolDecl`s. Renderer surfaces the spec's `[overload]` / `[implementation]` / `[declaration]` bracket tags derived from `nativeLabel`. `--json` produces structured output.

### Test cases (TDD-first)

| Test | Assertion | Level | Fixture / setup |
|---|---|---|---|
| Identity with no disambiguators returns single match when name is unique in scope | One symbol returned | unit (backend) | new fixture `definition-cases` |
| Identity with leaf disambiguator returns exactly that overload | One symbol returned | unit (backend) | fixture with overloaded function |
| Identity without leaf disambiguator on overloaded name returns all overloads + implementation | N+1 symbols (N overloads + impl) | unit (backend) | fixture with overloaded function |
| Identity with ancestor wildcard returns matches under all ancestors | Multiple symbols when ancestor collides | unit (backend) | fixture with namespace + class declaration merge |
| Interface method identity returns declaration + every implementation across workspace | Three symbols when there's one interface and two impls | unit (backend) | fixture with interface and two impl classes in separate files |
| Abstract method identity returns abstract decl + every concrete override | Same shape | unit (backend) | fixture with abstract class and two subclasses |
| Identity for a top-level value/type returns one match, no expansion | One symbol returned | unit (backend) | fixture |
| Identity referring to nonexistent file → command errors with `Cannot answer:` | E2E error path | e2e | none |
| Identity referring to file but nonexistent symbol path → empty result rendered with appropriate header | E2E renders "no matching definitions" | e2e | fixture |
| Renderer text output groups symbols by file with bracket tags | Snapshot | unit | sample `DefinitionResult` |
| Renderer JSON output matches snapshot | Snapshot | unit | sample `DefinitionResult` |
| E2E `symnav def src/.../Router::post` returns all three signatures with `[overload]`/`[implementation]` tags | Snapshot | e2e | `definition-cases` fixture |
| E2E `symnav def src/.../PaymentProvider::charge` returns declaration + two implementations across files | Snapshot | e2e | fixture |
| E2E `symnav def <id>#1` (with leaf disambiguator) returns exactly that one symbol | Snapshot | e2e | fixture |
| Bad-format ID produces `Cannot answer: invalid symbol id` (via `InvalidSymbolIdError`) | E2E error path | e2e | none |

### Components

New backend module `packages/backend-typescript/src/definition/find-definitions.ts`:

```ts
export function findDefinitions(
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly SymbolDecl[]>;
```

Implementation notes:
- Build a `ts-morph Project` over `files`.
- Open the file identified by `identity.file`; extract its symbol tree (same as `fileSymbols`).
- Walk the tree by `identity.path`: at each level, match by `name`; if the segment has a `disambiguator`, also match that; otherwise admit every same-name match. Recurse into matched ancestors' children.
- For each leaf match: if it is a contract (interface method, abstract method, abstract class itself), use ts-morph to find implementations across the project (`getImplementations()` or equivalent) and include each as its own `SymbolDecl` (with its own identity).
- Return the union as a flat list.

Refine TypeScript-backend `nativeLabel` values to encode definition shape where it matters:

| Today | After |
|---|---|
| `method` | `method-implementation` (has body), `method-declaration` (interface/abstract/`.d.ts` declaration), `method-overload-signature` (signature in an overload set) |
| `function` | `function-implementation`, `function-overload-signature` (TS allows overloaded standalone functions) |
| `constructor` | `constructor-implementation`, `constructor-overload-signature` |
| `getter`, `setter`, others | unchanged for v1 unless they form overload sets |

Role assignments stay `callable` for all. Update `TypeScriptSymbolKind` and `ROLE_BY_KIND` accordingly.

New result type and command in `apps/cli/src/commands/def/`:

```ts
// definition-result.ts
export interface DefinitionResult {
  readonly identity: SymbolIdentity;
  readonly symbols: readonly SymbolDecl[];
}

// def-command.ts
export interface DefArgs {
  readonly symbolId: string;
}

export const defCommand: Command<DefinitionResult, DefArgs>;
```

`defCommand.compute`:
- Parse `ctx.args.symbolId` via `parseSymbolIdentity` (throws `InvalidSymbolIdError` on bad input).
- Resolve the file portion via `ctx.workspace.resolveInputPath(identity.file, ctx.cwd)` to confirm existence and ignore status.
- Confirm the file is accepted by some backend: `ctx.router.findOrThrow(resolvedPath.relative)`.
- Enumerate workspace files via `ctx.workspace.enumerate()`.
- Partition: for each backend, filter to its accepted files.
- Find the owning backend by `resolvedPath.relative` (same `findOrThrow` call) and pass it the full accepted-files list plus the identity: `backend.findDefinitions(slice, identity)`.
- Return `DefinitionResult`.

New renderer surface `packages/renderer/src/definition/`:

```ts
// render-definition-text.ts
export function renderDefinitionText(result: DefinitionResult): string;

// render-definition-json.ts
export function renderDefinitionJson(result: DefinitionResult): string;

// definition-tag.ts
export function bracketTagFor(nativeLabel: string): string | undefined;
```

`bracketTagFor` is a small mapping table:
- `method-implementation`, `function-implementation`, `constructor-implementation` → `implementation`
- `method-declaration` → `declaration`
- `method-overload-signature`, `function-overload-signature`, `constructor-overload-signature` → `overload`
- everything else → `undefined` (no tag shown)

New CLI registration `apps/cli/src/commands/def/register-def-command.ts`:

```ts
export function registerDefCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void;
```

`program.command("def <symbol-id>")` with `.option("--json", ...)`.

### Commit plan

1. **Add `definition-cases` fixture.** Includes: a `Router.ts` with overloaded `post`; a `PaymentProvider.ts` interface with `charge`; `StripeProvider.ts` and `PaypalProvider.ts` implementing it; an abstract class fixture; a namespace/class merge case. `.gitignore` and `dot-git/`. *(Hygiene: fixture-only.)*
2. **Refine TypeScript `nativeLabel` to encode definition shape.** Update `TypeScriptSymbolKind` enum and `ROLE_BY_KIND`. Update extractor to emit the refined labels. Update existing overview fixtures whose snapshots reference old labels — *but* if the renderer doesn't surface `nativeLabel` directly in overview text, snapshots should be unchanged. (If overview snapshots do print `nativeLabel`, this commit updates them.) *(Hygiene: one logical change — label refinement; downstream renderer changes follow only if necessary.)*
3. **Add `bracketTagFor` and renderer tests (failing).** Mapping table plus snapshot tests against synthetic `DefinitionResult`. *(Hygiene: tests-first.)*
4. **Implement def renderer (text + JSON) and export from `@symnav/renderer`.** Snapshots go green. *(Hygiene: implementation follows tests.)*
5. **Add `DefinitionResult` type.** Type-only file. *(Hygiene: type-only, no callsites.)*
6. **Add `findDefinitions` unit tests (failing).** Cover wildcard rules, overload expansion, multi-impl expansion, abstract expansion, ancestor collision. *(Hygiene: tests-first.)*
7. **Implement `TypeScriptBackend.findDefinitions`** (replacing the stub). Includes the multi-impl expansion via ts-morph. *(Hygiene: implementation follows tests.)*
8. **Add `defCommand` and `registerDefCommand`.** Compose parser + workspace resolution + backend + renderer. Register in `program.ts`. *(Hygiene: one logical change — new command on CLI.)*
9. **Add def e2e tests.** Overloads, multi-impl, leaf-disambiguator, bad-format-id, empty-match, ignored-file. *(Hygiene: end-to-end verification.)*
10. **Update `plans/000/symnav-functional-spec.md` Stage 2 examples** to reflect the locked decisions: numeric `#N` disambiguators (replacing `#overload1`/`#implementation`) and the Files-section non-overlap rule. *(Hygiene: documentation-only change; co-locates spec with reality.)*

### Done when

- `symnav def <symbol-id>` produces spec-conformant output against `definition-cases` fixtures, including the multi-implementation case.
- Bracket tags `[overload]` / `[implementation]` / `[declaration]` render correctly from `nativeLabel`.
- Wildcards on missing disambiguators behave as specified.
- `InvalidSymbolIdError` surfaces as `Cannot answer: …`.
- `--json` emits parseable structured output.
- Functional spec updated to match.
- Full CI-parity sequence green.

---

## Out of scope

- **Pagination** for `resolve` or `def` — Stage 3 (`refs`) is where pagination first appears per [`plans/000/symnav-stages.md`](../symnav-stages.md).
- **Cross-file reference enumeration** — Stage 3 (`refs`).
- **Direct callers/callees** — Stage 4 (`context`).
- **Multi-hop graph traversal** — Stage 5 (`graph`).
- **ANSI highlighting of matched substrings in terminal output** — defer to Stage 6 (release hardening) error-message review pass.
- **Additional language backends** — beyond v1.
- **Auto-`def` on a single `resolve` hit** — explicitly out per the spec's "stop and show candidates" ethos; `resolve` always shows what it found and lets the user decide.
- **Daemon / persistent process / warm caches** — beyond v1.
- **`SymbolIdentity` representations other than `<file>::<segments>`** (e.g. file-last grammar, quoted file paths) — the codec is structured to make this a one-module change later; this plan ships the file-first grammar only.
