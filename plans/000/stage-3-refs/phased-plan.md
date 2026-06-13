# Stage 3 — `refs`: phased implementation plan

Detailed plan for delivering Stage 3 of [`plans/000/symnav-stages.md`](../symnav-stages.md): the `symnav refs` command — workspace-wide reference enumeration with kind tagging, match-preserving preview trimming, stable pagination, and the compact filesystem-tree output.

Decisions below were settled in a drill-down session (2026-06-12):

- **Four reference kinds: `usage`, `import`, `export`, `type`.** The spec's `test` kind is dropped — the file path already tells the reader. The functional spec's `refs` example is edited accordingly.
- **`import type` is `import`**, not `type`. The kind answers "what construct references it?".
- The backend returns the **verbatim source line plus the match span**; all trimming and whitespace stripping is renderer-only. `--full-lines` emits the line verbatim (indentation preserved) — the faithful escape hatch for space-sensitive languages.
- **Core owns pagination.** `compute` sorts (path → line → matchStart), counts kinds, and slices the page; the renderer is a pure presentation function over the page slice. Invalid, conflicting, or out-of-range page requests are `UserFacingError`s, never silently empty output.
- **The tree is built per page.** Single-child collapsing operates on the page's references only; visual grouping may differ between pages, the references themselves never do.
- **Symbol-not-found is an error, distinct from `Total: 0`.** Note: `def` renders `(no matching definitions)` with exit 0 instead. The asymmetry is deliberate — for `refs`, an empty listing is a meaningful answer ("nothing references this"), so a missing symbol must not masquerade as one.

## Goal

After this plan lands, `symnav refs <symbol-id> [--page <n>] [--page-size <n>] [--all] [--full-lines] [--json]` works end-to-end: it lists every reference to the symbol across non-ignored workspace files, excluding the symbol's own definition/declaration, each tagged `usage`/`import`/`export`/`type`, rendered as a compact filesystem tree with single-child directory collapsing, paginated with stable ordering. Under the hood the project gains its first cross-file semantic query (`LanguageBackend.findReferences`), a reusable pagination primitive in `core`, and the renderer's first directory-tree surface.

## Context

The codebase reflects Stage 2 (`resolve`, `def`). Relevant surface:

- **`@symnav/core`**
  - IR (`packages/core/src/intermediate-representation/`): `SymbolDecl`, `SymbolIdentity` (`{file, segments}`), `SymbolKind`, `Signature`, `LineRange`, `ResolveResult`, `DefinitionResult`; codec `parseSymbolIdentity`/`formatSymbolIdentity` (`canonical-identity.ts`).
  - Workspace (`packages/core/src/workspace/`): `Workspace` with `resolveInputPath(inputPath, cwd)` and `enumerate()`, both returning `ResolvedPath {relative, absolute}` (workspace-relative, POSIX). `enumerate()` already skips ignored files and sorts by relative path.
  - Backend (`packages/core/src/backend/`): `LanguageBackend` with `accepts`, `fileSymbols`, `resolveSymbols`, `findDefinitions`; `BackendRouter.findOrThrow`; `UnsupportedFileError` in `backend/errors.ts`.
  - Errors: abstract `UserFacingError` (`errors.ts`) with `reason` getter; `runCommand` renders `Cannot answer: <reason>.` to stderr with exit 1.
- **`@symnav/backend-typescript`**: `TypeScriptBackend` delegates each method to a module (`resolve/resolve-symbols.ts`, `definition/find-definitions.ts`). `find-definitions.ts` contains the identity-matching machinery this plan reuses: walking `SymbolIdentity.segments` through `extractFileSymbols` output and locating the matching ts-morph `Node` (`locateDeclarationNode`, `ownSegmentMatches`, `identityKey`). Projects are built over `WorkspaceFileSystemHost`.
- **`@symnav/renderer`**: per-command directories (`overview/`, `resolve/`, `definition/`) with `render-<cmd>-text.ts` / `render-<cmd>-json.ts` pairs; shared glyph/format helpers in `shared/render-format.ts` (`treeGlyphsFor`, `formatIdentityPath`, `formatRange`); JSON renderers are `JSON.stringify(result, null, 2) + "\n"`. `signature-cap.ts` establishes `…` as the house ellipsis.
- **`apps/cli`**: `Command<Result, Args>` (`command.ts`) with `compute`/`renderText`/`renderJson`; `runCommand` owns workspace creation, router construction, error dispatch, exit codes. Per-command pairs under `src/commands/<cmd>/` (`<cmd>-command.ts`, `register-<cmd>-command.ts`). Renderers receive only the result, so presentation flags ride in the result (precedent: `ResolveResult.fuzzy`).
- **Tests**: Vitest. Unit colocated (`src/foo.test.ts`); backend unit tests parse in-memory sources via `test/helpers/parse-typescript-source`; integration under `<package>/test/integration/`; e2e under `apps/cli/test/e2e/<cmd>/` spawning the built binary via `runSymnavBinary`, snapshotting with `toMatchFileSnapshot`, fixtures via `fixturePath(name)` with the `dot-git/` marker renamed by `ensureFixtureGitMarker`.

What this plan reuses unchanged: the identity codec, `Workspace`, `BackendRouter`, error dispatch, `treeGlyphsFor`/`formatIdentityPath`, the `Command` pipeline, fixture conventions.

What this plan adds:

- Core: `ReferenceKind`, `Reference`, `RefsResult`; `paginate` + `PageRequest` + page errors; `SymbolNotFoundError`; `buildRefsResult` (sort → count → paginate).
- Backend: `LanguageBackend.findReferences(files, identity)`; TypeScript implementation over ts-morph reference search with kind classification.
- Renderer: `refs/` surface — preview trimming, per-page reference tree with single-child collapsing, text/JSON renderers.
- CLI: `refs` command and registration; `refs-cases` fixture; e2e coverage.

## Phase 1 — Core reference model and pagination

**Behavior delivered.** `@symnav/core` exports the reference IR, a tested pagination primitive with spec-default behavior and error paths, `SymbolNotFoundError`, and `buildRefsResult` — everything a command needs to turn a flat reference list plus page flags into a renderable result. The functional spec no longer promises a `test` kind.

**Test cases.**

| Test | Assertion | Level | Setup |
|---|---|---|---|
| `paginate` defaults | 250 items, empty request → items 1–100, `page: 1`, `pageCount: 3` | unit | none |
| `paginate` explicit page | `{page: 3}` of 250 → items 201–250 | unit | none |
| `paginate` custom page size | `{page: 2, pageSize: 3}` of 7 → items 4–6, `pageCount: 3` | unit | none |
| `paginate` `--all` | `{all: true}` of 250 → all items, `page: 1`, `pageCount: 1` | unit | none |
| `paginate` empty input | 0 items → `items: []`, `page: 1`, `pageCount: 1` (no error) | unit | none |
| `paginate` out-of-range page | `{page: 5}` of 7 with `pageSize: 3` → throws `PageOutOfRangeError`; `reason` names requested page and page count | unit | none |
| `paginate` invalid page | `{page: 0}`, `{page: -1}`, `{page: 1.5}`, `{page: NaN}` → throws `InvalidPageRequestError` | unit | none |
| `paginate` invalid page size | `{pageSize: 0}`, `{pageSize: NaN}` → throws `InvalidPageRequestError` | unit | none |
| `paginate` conflicting flags | `{page: 2, all: true}` → throws `InvalidPageRequestError` | unit | none |
| Page errors are user-facing | both error classes `instanceof UserFacingError` | unit | none |
| `SymbolNotFoundError` reason | reason contains the formatted canonical ID | unit | none |
| `buildRefsResult` sorts | unsorted references → ordered by file, then line, then matchStart | unit | hand-built `Reference[]` |
| `buildRefsResult` counts kinds | `kindCounts` covers all four kinds with zeros, counted across the **full** set, not the page | unit | hand-built `Reference[]` |
| `buildRefsResult` paginates | `{page: 2, pageSize: 3}` → `references` holds the second sorted triple; `total` is the full count | unit | hand-built `Reference[]` |
| `buildRefsResult` threads `fullLines` | flag appears verbatim on the result | unit | none |

**Components.**

New file `packages/core/src/intermediate-representation/references.ts`:

```ts
export type ReferenceKind = "usage" | "import" | "export" | "type";

export interface Reference {
  readonly file: string; // workspace-relative, POSIX separators
  readonly line: number; // 1-based
  readonly previewSource: string; // verbatim source line, no trailing newline
  readonly matchStart: number; // 0-based char offset into previewSource, inclusive
  readonly matchEnd: number; // exclusive
  readonly kind: ReferenceKind;
}

export interface RefsResult {
  readonly identity: SymbolIdentity;
  readonly total: number; // across all pages
  readonly kindCounts: Readonly<Record<ReferenceKind, number>>; // across all pages
  readonly page: number;
  readonly pageCount: number;
  readonly fullLines: boolean;
  readonly references: readonly Reference[]; // the page slice, sorted
}
```

New directory `packages/core/src/pagination/` — `paginate.ts`:

```ts
export const DEFAULT_PAGE_SIZE = 100;

export interface PageRequest {
  readonly page?: number; // 1-based
  readonly pageSize?: number;
  readonly all: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
}

export function paginate<T>(items: readonly T[], request: PageRequest): Page<T>;
```

Contract: `page`/`pageSize` must be positive integers when present; `all` combined with an explicit `page` is invalid; `pageCount` is `max(1, ceil(items.length / pageSize))`, so an empty result is a valid single page; a `page` beyond `pageCount` throws rather than returning an empty slice.

`packages/core/src/pagination/errors.ts`:

```ts
export class InvalidPageRequestError extends UserFacingError {
  constructor(detail: string);
}

export class PageOutOfRangeError extends UserFacingError {
  constructor(requestedPage: number, pageCount: number);
}
```

New error in `packages/core/src/backend/errors.ts`:

```ts
export class SymbolNotFoundError extends UserFacingError {
  constructor(identity: SymbolIdentity);
  // reason: `no symbol ${formatSymbolIdentity(identity)} found`
}
```

New file `packages/core/src/intermediate-representation/build-refs-result.ts`:

```ts
export interface BuildRefsResultArgs {
  readonly identity: SymbolIdentity;
  readonly references: readonly Reference[];
  readonly pageRequest: PageRequest;
  readonly fullLines: boolean;
}

export function buildRefsResult(args: BuildRefsResultArgs): RefsResult;
```

Sort comparator: `file` (plain lexicographic, matching `Workspace.enumerate`), then `line`, then `matchStart` — all ascending.

`packages/core/src/index.ts` additionally exports: `ReferenceKind`, `Reference`, `RefsResult`, `paginate`, `PageRequest`, `Page`, `DEFAULT_PAGE_SIZE`, `InvalidPageRequestError`, `PageOutOfRangeError`, `SymbolNotFoundError`, `buildRefsResult`.

**Commit plan.**

1. `spec: retag test references as usage in refs example` — edits `symnav-functional-spec.md`'s `refs` example (`[test]` → `[usage]`, kinds line recomputed); doc-only, records the taxonomy decision before code depends on it.
2. `core: add reference IR types` — `references.ts` types only; type-only, no callsites yet.
3. `core: add pagination error types` — `pagination/errors.ts` with reason-string unit tests; types before their first use.
4. `core: add paginate primitive` — failing tests then implementation in the same commit (a new pure module's red tests don't compile alone); one logical change: a tested pagination unit.
5. `core: add SymbolNotFoundError` — error class plus reason unit test; no thrower yet.
6. `core: add buildRefsResult` — tests then implementation; first consumer of `paginate` and the reference types.
7. `core: export reference model and pagination from index` — export-only commit, keeps the surface change reviewable at a glance.

**Done when.** All new unit tests green; `pnpm build && pnpm test && pnpm lint && pnpm typecheck` green; no behavior change to existing commands; spec example no longer mentions a `test` kind.

## Phase 2 — Backend reference discovery

**Behavior delivered.** `TypeScriptBackend.findReferences(files, identity)` returns every reference to the identified symbol across the given files — classified, definition-excluded, with verbatim preview lines and match spans — and throws `SymbolNotFoundError` when the identity matches nothing. `LanguageBackend` carries the method as part of the cross-language contract.

**Test cases.** Colocated unit tests under `packages/backend-typescript/src/references/`, building in-memory projects via the existing `parse-typescript-source` helper / `InMemoryFileSystem` pattern used by `find-definitions.test.ts`.

| Test | Assertion | Level | Setup |
|---|---|---|---|
| Cross-file discovery | references found in files other than the defining file | unit | 3-file in-memory project |
| Definition and declaration excluded | the class declaration line and interface declaration line are absent; only true references returned | unit | interface + implementation |
| Overload declarations excluded | identity matching a function with overloads returns call sites only, none of the overload signature lines | unit | overloaded function |
| `import` classification | named import, default import, `import type { X }` all → `kind: "import"` | unit | importer files |
| `export` classification | `export { X }`, `export { X } from "./x"` (re-export) → `kind: "export"` | unit | barrel file |
| `type` classification | type annotation, generic type argument, `implements X`, `typeof X` in type position → `kind: "type"` | unit | consumer file |
| `usage` classification | call, `new`, property access, `extends` of a concrete class, identifier read → `kind: "usage"` | unit | consumer file |
| Re-export chain followed | a use imported via a barrel still resolves as a reference to the original symbol | unit | `index.ts` barrel + consumer |
| Match span | `previewSource.slice(matchStart, matchEnd)` equals the symbol name; `previewSource` is the verbatim line including indentation | unit | indented call site |
| Two references on one line | both returned, distinct `matchStart` | unit | `f(X, X)`-shaped line |
| Zero references | unexported unused symbol → `[]` (no throw) | unit | lone class |
| Unknown symbol | identity matching no declaration → throws `SymbolNotFoundError` | unit | any project |
| Method references | identity `file::Class::method` finds call sites of the method, not the class | unit | class with method |
| Existing `def`/`resolve`/`overview` suites | unchanged after the extraction refactor | unit/integration/e2e | existing fixtures |

**Components.**

New file `packages/backend-typescript/src/identity/locate-declarations.ts` — a pure extraction of the identity-matching machinery currently private to `find-definitions.ts` (`locateDeclarationNode`, `ownSegmentMatches`, segment-walk over `extractFileSymbols`, `identityKey`/`segmentKey`), exposing:

```ts
export interface LocatedDeclaration {
  readonly declaration: SymbolDecl;
  readonly node: Node;
}

export function locateDeclarationsMatchingIdentity(
  sourceFile: SourceFile,
  identity: SymbolIdentity,
): readonly LocatedDeclaration[];

export function identityKey(identity: SymbolIdentity): string;
```

`find-definitions.ts` becomes a consumer of this module; its behavior is unchanged.

New file `packages/backend-typescript/src/references/classify-reference-kind.ts`:

```ts
export function classifyReferenceKind(node: Node): ReferenceKind;
```

Classification by enclosing context, first match wins: ancestor import declaration → `import`; ancestor export declaration / export specifier / export assignment → `export`; type position (delegating to the TypeScript compiler's own type-node classification via `ts.isPartOfTypeNode`-style checks, not hand-rolled) → `type`; otherwise `usage`.

New file `packages/backend-typescript/src/references/find-references.ts`, mirroring `find-definitions.ts`'s shape (args interface + class over a `Project` on `WorkspaceFileSystemHost`):

```ts
export interface FindReferencesArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findReferences(args: FindReferencesArgs): Promise<readonly Reference[]>;
```

Behavior in prose: load all given files into one project; locate the declaration node(s) matching the identity in the target file (throw `SymbolNotFoundError` if none); run ts-morph reference search from the declaration name node(s); drop entries the search marks as definitions/declarations; union across matched declarations, deduplicating by `(file, line, matchStart)`; map each surviving entry to a `Reference` with the workspace-relative path, 1-based line, verbatim line text, match span, and classified kind. No sorting — ordering is `buildRefsResult`'s job.

`TypeScriptBackend` gains:

```ts
async findReferences(
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly Reference[]>;
```

`LanguageBackend` (in core) gains the same signature.

**Commit plan.**

1. `backend-typescript: extract declaration locating from find-definitions` — pure move of the identity-matching helpers into `identity/locate-declarations.ts`; no edits inside the moved code, existing tests prove behavior unchanged.
2. `backend-typescript: add reference-kind classification` — tests then `classify-reference-kind.ts`; pure addition, no callers yet.
3. `backend-typescript: add findReferences reference discovery` — tests then `references/find-references.ts`; the module exists but nothing routes to it.
4. `backend-typescript: implement findReferences on TypeScriptBackend` — one delegating method; class compiles independently of the interface change.
5. `core: add findReferences to LanguageBackend` — interface-only commit; `TypeScriptBackend` already conforms, so the workspace stays green.

**Done when.** All backend unit tests green; existing `def`/`resolve`/`overview` tests byte-identical; full CI-parity sequence green.

## Phase 3 — Renderer refs surface

**Behavior delivered.** `@symnav/renderer` exports `renderRefsText` and `renderRefsJson`. Text output matches the spec's format: header block (`References:`/`Total:`/`Kinds:`/`Page:`/`Sort:`), then a compact filesystem tree with single-child directory collapsing, one `<line>: <preview>  [<kind>]` entry per reference, trimmed previews by default and verbatim lines when the result says `fullLines`.

**Test cases.** Unit tests colocated under `packages/renderer/src/refs/`, driving hand-built `Reference`/`RefsResult` values.

| Test | Assertion | Level | Setup |
|---|---|---|---|
| Trim: short line | ≤ budget after whitespace strip → returned stripped, no ellipsis | unit | none |
| Trim: indentation stripped | leading/trailing whitespace removed; match still rendered intact | unit | indented line |
| Trim: tail truncation | long line, match within first 80 chars → head kept, trailing `…`, output length ≤ 80 | unit | none |
| Trim: window slide | match beyond char 80 → leading `…`, match fully visible | unit | none |
| Trim: both ends | match mid-line with overflow both sides → `…` on both ends | unit | none |
| Trim: match wider than budget | match itself > 80 chars → starts at match, trailing `…` (preserved "when possible") | unit | none |
| Tree: all-one-file page | single file → whole directory chain collapses into one root label, line entries as children | unit | refs in one file |
| Tree: spec example shape | the spec's six-reference example produces exactly its tree (`src/` root, `checkout/CheckoutService.ts` collapsed, `payments/` expanded, `tests/payments/...` collapsed) | unit | hand-built refs mirroring the spec example |
| Tree: file and line entries stay separate levels | a file with one reference still renders file node + child line entry | unit | none |
| Tree: multiple top-level roots | files under `src/` and `tools/` → two top-level siblings | unit | none |
| Text: full header | `References: <symbol-path>`, `Total`, `Kinds` in fixed order (`usage, import, export, type`) omitting zero counts, `Page: n/m`, `Sort: path, line`, blank line, tree | unit | none |
| Text: zero references | header with `Total: 0`, no `Kinds:` line, no tree | unit | none |
| Text: `--full-lines` | `fullLines: true` → previews verbatim, indentation preserved, no `…` | unit | indented + long lines |
| JSON | `renderRefsJson` is `JSON.stringify(result, null, 2) + "\n"`, parseable round-trip | unit | none |

**Components.** All under new `packages/renderer/src/refs/`.

`trim-preview.ts`:

```ts
export const PREVIEW_WIDTH = 80;

export function trimPreview(reference: Reference): string;
export function fullPreview(reference: Reference): string; // verbatim previewSource
```

Trimming in prose: strip surrounding whitespace (shifting the match span accordingly); if the stripped line fits `PREVIEW_WIDTH`, return it; otherwise choose the window that keeps the match visible — head-anchored with trailing `…` when the match fits the first 80 characters, otherwise slid to contain the match with leading (and, when text remains, trailing) `…`. Ellipsis characters count toward the width. Reuses the `…` convention from `signature-cap.ts` but keeps its own constant — no shared trimming module until a second consumer exists.

`reference-tree.ts`:

```ts
export interface ReferenceTreeDirectory {
  readonly label: string; // e.g. "src/" or collapsed "payments/"
  readonly children: readonly ReferenceTreeNode[];
}

export interface ReferenceTreeFile {
  readonly label: string; // e.g. "RefundService.ts" or collapsed "checkout/CheckoutService.ts"
  readonly references: readonly Reference[];
}

export type ReferenceTreeNode = ReferenceTreeDirectory | ReferenceTreeFile;

export function buildReferenceTree(references: readonly Reference[]): readonly ReferenceTreeNode[];
```

In prose: build a directory trie from the page's file paths (already sorted), then collapse every directory with exactly one child into that child by prefixing its label with the directory name and `/` — collapsing merges directories into files too (`tests/payments/PaymentProcessor.test.ts`), but a file never merges with its line entries. Pure directory labels keep a trailing `/`.

`render-refs-text.ts` / `render-refs-json.ts`:

```ts
export function renderRefsText(result: RefsResult): string;
export function renderRefsJson(result: RefsResult): string;
```

Text rendering reuses `treeGlyphsFor` and `formatIdentityPath` from `shared/render-format.ts`; reference entries follow the spec grammar `<line>: <preview>  [<kind>]`.

`packages/renderer/src/index.ts` exports both.

**Commit plan.**

1. `renderer: add preview trimming` — tests then `trim-preview.ts`; pure function, no callers.
2. `renderer: add reference tree builder` — tests then `reference-tree.ts`; pure function, no callers.
3. `renderer: add refs text renderer` — tests then `render-refs-text.ts` plus its index export; first consumer of the two helpers.
4. `renderer: add refs JSON renderer` — tests then `render-refs-json.ts` plus its index export; one logical change kept separate from the text surface.

**Done when.** Renderer unit tests green, including a byte-exact reproduction of the spec's example tree; CI-parity sequence green.

## Phase 4 — CLI command, fixture, and end-to-end coverage

**Behavior delivered.** `symnav refs <symbol-id>` works against a real workspace from the built binary, with `--page`, `--page-size`, `--all`, `--full-lines`, `--json`, the spec's error voice for every failure path, and byte-stable output across runs.

**Test cases.** E2E under `apps/cli/test/e2e/refs/refs.test.ts`, run against the new fixture with `runSymnavBinary`, snapshots via `toMatchFileSnapshot`, `ensureFixtureGitMarker` in `beforeAll`.

| Test | Assertion | Level | Fixture case |
|---|---|---|---|
| Default output | snapshot: header + collapsed tree, kinds spanning usage/import/export/type, references from many files | e2e | `PaymentProcessor` |
| Definition excluded | defining line of `PaymentProcessor` absent from output; `Total` matches hand count | e2e | `PaymentProcessor` |
| Re-export chain | barrel `export ... from` tagged `[export]`; consumer importing via the barrel still listed | e2e | `index.ts` barrel + `RefundService` |
| Test-looking file is plain usage | reference inside `tests/.../*.test.ts` tagged `[usage]`, no special kind | e2e | test file in fixture |
| Ignored files excluded | references inside the `.gitignore`d file absent from output and counts | e2e | `src/ignored-stuff.ts` |
| Same-line references | two entries with the same line number, ordered by column | e2e | `SameLine.ts` |
| Trimming | long line trimmed with `…`, match visible | e2e (snapshot) | `LongLine.ts` |
| `--full-lines` | same query verbatim: indentation kept, no `…` | e2e (snapshot) | `LongLine.ts` |
| Zero references | snapshot: `Total: 0`, no `Kinds:` line, no tree; exit 0 | e2e | unused exported class |
| Pagination pages | `--page-size 3` page 1 and page 2 snapshots; page sets disjoint | e2e | `PaymentProcessor` |
| Pagination stability | running page 2 twice yields byte-identical stdout | e2e | `PaymentProcessor` |
| Out-of-range page | `--page 99` → exit 1, stderr `Cannot answer:` naming page count | e2e | any |
| Invalid page | `--page 0` → exit 1, `Cannot answer:` | e2e | any |
| Conflicting flags | `--all --page 2` → exit 1, `Cannot answer:` | e2e | any |
| Symbol not found | existing file, bogus symbol path → exit 1, `Cannot answer: no symbol … found` | e2e | any |
| Malformed ID / missing file / ignored file | `def`-parity error paths: exit 1 with the established messages | e2e | `src/ignored-stuff.ts` |
| `--json` | parseable; `identity`, `total`, `kindCounts`, `page`, `pageCount`, `references[*].{file,line,kind,matchStart,matchEnd}` match expectations | e2e | `PaymentProcessor` |

**Components.**

New fixture `packages/testing/fixtures/refs-cases/` (with `package.json`, `.gitignore` listing `src/ignored-stuff.ts`, `dot-git/HEAD`):

- `src/payments/PaymentProcessor.ts` — the primary target class with methods; also an unused exported class for the zero-refs case.
- `src/payments/index.ts` — `export { PaymentProcessor } from "./PaymentProcessor"`.
- `src/checkout/CheckoutService.ts` — import + call + type-annotation references.
- `src/billing/RefundService.ts` — imports via the barrel, usage references.
- `src/multi/SameLine.ts` — two references on one line.
- `src/long/LongLine.ts` — one reference early and one late on pathologically long lines.
- `tests/payments/PaymentProcessor.test.ts` — usage references in a test-looking path.
- `src/ignored-stuff.ts` — references that must never appear.

Files stay small enough that expected totals are hand-countable; pagination is exercised with `--page-size 3`, not fixture bulk.

New files under `apps/cli/src/commands/refs/`:

```ts
// refs-command.ts
export interface RefsArgs {
  readonly symbolId: string;
  readonly page: number | undefined;
  readonly pageSize: number | undefined;
  readonly all: boolean;
  readonly fullLines: boolean;
}

export const refsCommand: Command<RefsResult, RefsArgs>;
```

`compute` in prose, mirroring `defCommand`: parse the identity; validate the file via `workspace.resolveInputPath`; `workspace.enumerate()`; `router.findOrThrow(identity.file)`; filter enumerated files by `backend.accepts`; `backend.findReferences(accepted, identity)`; return `buildRefsResult({identity, references, pageRequest, fullLines})`. Numeric flag strings from commander are converted with `Number` and validated inside `paginate` — the CLI adds no validation policy of its own.

```ts
// register-refs-command.ts
export function registerRefsCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void;
```

Options: `--page <n>`, `--page-size <n>`, `--all`, `--full-lines`, `--json`; registered in `program.ts` alongside the existing commands.

**Commit plan.**

1. `testing: add refs-cases fixture` — fixture project only; no test references it yet, reviewable as pure content.
2. `cli: add refs e2e coverage` — the e2e suite, committed red; the failure (`unknown command 'refs'`) is informative and documents the surface being added.
3. `cli: add refs command` — `refs-command.ts`, `register-refs-command.ts`, `program.ts` wiring, and the snapshot files the now-green suite writes; one logical change: the command surface.

**Done when.** Full e2e suite green from the built binary; same query/state produces byte-identical pages across repeated runs; no reference kind filtered; full CI-parity sequence (`pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint && pnpm typecheck`) green. Stage 3's done-criteria in `symnav-stages.md` are met.

## Out of scope

- **Callers/callees and any graph concept** — Stage 4 (`context`) introduces one-hop discovery; Stage 5 (`graph`) owns traversal.
- **Promoting `reference-tree.ts`/`trim-preview.ts` to `renderer/src/shared/`** — deferred until `context` (Stage 4) becomes the second consumer.
- **Path-based pagination** — `graph`-specific (Stage 5); this stage ships only the list-slicing `paginate`.
- **ANSI highlighting of matched symbols in terminal output** — spec marks it optional ("may be highlighted"); no stage owns it yet.
- **A `test` reference kind or any test-file detection** — deliberately dropped from the taxonomy; the path conveys it.
- **README / agent-facing usage docs** — Stage 6 (release hardening) owns user documentation; the functional-spec edit in Phase 1 is the only doc change here.
- **Performance work** — cold-per-invocation double-parse concerns (one `Project` per command) are measured in Stage 6's baseline, not optimized here.
