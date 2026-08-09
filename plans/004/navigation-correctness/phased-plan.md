# Navigation Correctness and Target Matching Phased Plan

This plan turns the [navigation correctness functional spec](../navigation-correctness-functional-spec.md) into six independently green implementation phases.

## Goal

Make existing navigation commands select the strongest regular target, support explicit case-sensitive canonical-ID regexes, explain target failures accurately, and attribute calls to their real containing declaration. Complete all 28 skipped end-to-end acceptance cases without changing existing result formats or adding commands.

## Context

`CommandTargetResolver` in `apps/cli/src/commands/resolve-symbol-target.ts` combines candidates from every language backend and owns final selection. `SymbolTargetGrammar` in `packages/core/src/target/symbol-target-pattern.ts` owns language-agnostic suffix syntax, while `TargetCandidateFinder` in `packages/backend-typescript/src/target/find-target-candidates.ts` enumerates TypeScript declarations. `SymbolTargetErrorRenderer` owns the multi-line ambiguity tree.

Regex compilation currently belongs only to `resolve` through `compileResolveRegex`. The four symbol commands share `CommandTargetResolver`, so one discriminated target-query contract can extend all four without adding backend methods.

`WorkspaceDeclarationIndex.declarationAt` currently keys declarations by source line. `CallerFinder` asks it about every ancestor, allowing a non-declaration ancestor on line one to inherit the file's first symbol. Exact declaration-node lookup fixes call ownership without changing reference payloads.

The acceptance baseline lives in `apps/cli/test/e2e/target-patterns/target-patterns.test.ts`, the context and graph suites, the resolve suite, and the overview targeting suite. Unit coverage belongs beside core and backend source; resolver orchestration coverage belongs under `apps/cli/test/integration/commands/`.

Every phase finishes with:

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint && pnpm typecheck
```

## Phase 1 — Truthful symbol-target failures

**Behavior delivered.** Regular symbol targets distinguish malformed syntax, missing files, never-matched targets, and matches removed by `--line`. Ambiguous output ends with copyable recovery guidance. Slashless and slashed missing file suffixes use the same missing-file vocabulary.

**Test cases.** Add these before production changes.

- Core unit: parsing `::charge`, an interior empty segment, and a trailing empty segment throws `InvalidSymbolTargetError` with the original explanation and raw target. Canonical-ID parsing still throws `InvalidSymbolIdError`.
- Core unit: `SymbolTargetLineMismatchError` renders `no symbol target "helper" matching line 99`.
- Core unit: not-found and ambiguity errors retain only the raw user target while preserving existing reason text and deterministic candidates.
- CLI integration: candidates are collected across all backends before line filtering. Zero pre-line matches produce `SymbolTargetNotFoundError`; nonzero pre-line matches removed by line filtering produce `SymbolTargetLineMismatchError`.
- CLI integration: moving line filtering out of a backend preserves positive-integer validation and unique/ambiguous target behavior.
- CLI integration: an unmatched slashless `missing.ts` suffix throws `FileNotFoundError("missing.ts")`. Slash and backslash path-like suffixes continue through workspace input-path validation.
- Renderer unit: ambiguity output ends with `Copy a candidate id, or narrow with --line.` after the candidate tree.
- E2E: re-enable the 16 line-filter, malformed-target, missing-file, and ambiguity-guidance rows in `target-patterns.test.ts`. Keep existing ignored-file and not-found assertions green.

**Components.** Core keeps canonical-ID failures separate from target-input failures. Backend candidate discovery becomes syntax-only; CLI owns line filtering after cross-backend collection.

```ts
export class InvalidSymbolIdError extends UserFacingError {
  constructor(readonly explanation: string, readonly raw: string);
  get reason(): string;
}

export class InvalidSymbolTargetError extends UserFacingError {
  constructor(readonly explanation: string, readonly raw: string);
  get reason(): string;
}

export class SymbolTargetLineMismatchError extends UserFacingError {
  constructor(readonly rawTarget: string, readonly line: number);
  get reason(): string;
}

export class SymbolTargetNotFoundError extends UserFacingError {
  constructor(readonly rawTarget: string);
  get reason(): string;
}

export class AmbiguousSymbolTargetError extends UserFacingError {
  constructor(
    readonly rawTarget: string,
    readonly candidates: readonly SymbolTargetCandidate[],
  );
  get reason(): string;
}

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileEntries(path: ResolvedPath): Promise<OverviewFileEntries>;
  resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]>;
  findTargetCandidates(
    files: readonly ResolvedPath[],
    pattern: SymbolTargetPattern,
  ): Promise<readonly SymbolTargetCandidate[]>;
  findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]>;
  findReferences(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolReference[]>;
  findCallTarget(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<CallTargetResolution>;
  findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]>;
  findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]>;
}

export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly line: number | string | undefined;
}

export class CommandTargetResolver {
  static resolve(args: ResolveSymbolTargetForCommandArgs): Promise<ResolvedCommandTarget>;
}
```

`ResolveSymbolTargetOptions` and `validateResolveSymbolTargetOptions` leave the public core surface once no backend consumes them. `SymbolTargetErrorRenderer.render(err)` remains the ambiguity-only structured renderer; single-line errors self-render through `UserFacingError`.

**Commit plan.**

1. `test: specify truthful symbol target failures` — Add failing core, resolver-integration, renderer, and re-enabled E2E coverage for this phase. Preserves TDD ordering; tests only.
2. `refactor: centralize symbol target line filtering` — Remove backend line options and move equivalent filtering into the cross-backend resolver without changing error output yet. Refactor only; no behavior change.
3. `core: define symbol target failure contracts` — Add/export target-input and line-mismatch errors, make not-found/ambiguity errors retain raw input, and expose canonical error fields needed for safe translation. Contract definitions only; no callsites yet.
4. `fix: classify symbol target failures accurately` — Use target-specific parse errors, raw-input result errors, pre-line candidate state, and suffix-aware missing-file handling in the resolver. First callsites follow the contract-only commit.
5. `renderer: guide ambiguous symbol target recovery` — Append copy-ID and `--line` guidance to the shared ambiguity renderer. One output change only.

**Done when.** All regular-target failures identify the actual failure stage, the 16 phase-specific skipped E2E cases pass for `def`, `refs`, `context`, and `graph`, existing output remains stable outside specified error text, and full CI parity passes.

## Phase 2 — Strongest regular-target selection

**Behavior delivered.** A uniquely strongest regular match wins. Full symbol paths outrank proper symbol suffixes, exact file paths outrank proper file suffixes, incomparable or tied strongest candidates remain ambiguous, and overload collapsing still applies only after strongest candidates are retained.

**Test cases.** Add these before production changes.

- Core unit: `SymbolTargetGrammar.match` reports exact versus suffix symbol-path specificity and exact, suffix, or unspecified file specificity.
- Core unit: dominance returns true only when one match is at least as specific in both dimensions and stronger in one. Crossed exact-symbol/suffix-file and suffix-symbol/exact-file matches are incomparable.
- Core unit: nonmatches return no match result; existing file boundary and disambiguator cases stay green.
- CLI integration: a full symbol-path candidate beats a proper suffix candidate across backends regardless of backend order or canonical-ID sort order.
- CLI integration: an exact file path beats a proper file suffix; equal maxima remain deterministically ambiguous.
- CLI integration: line filtering happens before ranking. Regular overload siblings still collapse only after ranking.
- E2E: re-enable the four `orders.ts::charge` rows and assert all four symbol commands choose `src/adapters/orders.ts::charge`.

**Components.** Core exports match strength because CLI consumes it across a package boundary. Specificity uses independent dimensions; it does not invent a lexicographic file-versus-symbol precedence.

```ts
export type SymbolPathSpecificity = "exact" | "suffix";
export type FilePathSpecificity = "exact" | "suffix" | "unspecified";

export interface SymbolTargetSpecificity {
  readonly symbolPath: SymbolPathSpecificity;
  readonly filePath: FilePathSpecificity;
}

export interface SymbolTargetMatch {
  readonly specificity: SymbolTargetSpecificity;
}

export class SymbolTargetGrammar {
  static match(
    pattern: SymbolTargetPattern,
    identity: SymbolIdentity,
  ): SymbolTargetMatch | undefined;

  static dominates(left: SymbolTargetSpecificity, right: SymbolTargetSpecificity): boolean;
}
```

Backend enumeration may use `match(...) !== undefined`; it does not choose a winner or add policy fields to `SymbolTargetCandidate`. `CommandTargetResolver` computes the non-dominated set after line narrowing and before overload collapse.

**Commit plan.**

1. `test: specify regular target specificity` — Add failing core dominance tests, resolver-integration matrices, and re-enable four strongest-match E2E rows. Preserves TDD ordering; tests only.
2. `core: define symbol target specificity contracts` — Add/export specificity and match-result types. Type definitions only; no callsites yet.
3. `core: compute symbol target specificity` — Replace boolean-only grammar matching with a match result and dominance policy. One core policy change.
4. `cli: select non-dominated target candidates` — Filter the combined candidate set before overload collapse and ambiguity handling. First cross-package use follows the contract commits.

**Done when.** All four commands select the adapter `charge` example, tied and incomparable matches stay ambiguous in canonical-ID order, overload behavior is unchanged, and full CI parity passes.

## Phase 3 — Regex matching for symbol commands

**Behavior delivered.** `def`, `refs`, `context`, and `graph` accept `--regex`. Patterns are compiled through the same validation path as `resolve`, tested case-sensitively against full canonical IDs, narrowed by `--line`, and handled as not-found, unique, or ambiguous without regular ranking or overload collapse.

**Test cases.** Add these before production changes.

- Core unit: shared regex compilation normalizes a valid pattern and reports invalid patterns with the rejected text, engine detail, and closed subject vocabulary for both `resolve` and `symbol target`.
- Core unit: existing resolve regex error text remains stable after the compiler/error generalization.
- Backend unit: regex queries match full canonical IDs, including file paths, nested segments, and overload disambiguators. Matching is case-sensitive and does not inspect headers, signatures, previews, or source text.
- Backend unit: regular query behavior stays unchanged through the discriminated query contract.
- CLI integration: regex candidates from multiple backends are combined, sorted, line-narrowed, and never specificity-ranked. Multiple overload IDs remain ambiguous.
- CLI command tests: all four registrations expose `--regex`; command argument descriptors include `regex` in telemetry flags without recording pattern content.
- E2E: re-enable the four ambiguous `charge$` rows. Add unique full-ID, line-narrowed, zero-match, invalid-regex, case-sensitivity, and overload-disambiguator coverage for each command where matrix coverage adds signal.
- E2E: command help lists `--regex`; text and JSON success results retain existing result shapes.

**Components.** One shared compiler owns JavaScript regex validation. One backend method handles regular and regex target queries.

```ts
export type RegexSubject = "resolve" | "symbol target";

export class InvalidRegexError extends UserFacingError {
  constructor(
    readonly subject: RegexSubject,
    readonly pattern: string,
    readonly detail: string,
  );
  get reason(): string;
}

export function compileRegex(pattern: string, subject: RegexSubject): RegExp;

export type SymbolTargetQuery =
  | {
      readonly mode: "regular";
      readonly pattern: SymbolTargetPattern;
    }
  | {
      readonly mode: "regex";
      readonly raw: string;
      readonly regex: RegExp;
    };

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileEntries(path: ResolvedPath): Promise<OverviewFileEntries>;
  resolveSymbols(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<readonly SymbolOverviewNode[]>;
  findTargetCandidates(
    files: readonly ResolvedPath[],
    query: SymbolTargetQuery,
  ): Promise<readonly SymbolTargetCandidate[]>;
  findDefinitions(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolOverviewNode[]>;
  findReferences(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly SymbolReference[]>;
  findCallTarget(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<CallTargetResolution>;
  findCallees(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]>;
  findCallers(
    files: readonly ResolvedPath[],
    identity: SymbolIdentity,
  ): Promise<readonly CallEdge[]>;
}

export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
}

export interface DefArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
}

export interface RefsArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
  readonly page: number | undefined;
  readonly pageSize: number | undefined;
  readonly all: boolean;
  readonly fullLines: boolean;
}

export interface ContextArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
}

export interface GraphArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
  readonly incoming: boolean;
  readonly outgoing: boolean;
  readonly depth: number | string | undefined;
  readonly page: number | undefined;
  readonly pageSize: number | undefined;
  readonly all: boolean;
}
```

`compileResolveRegex` and `InvalidResolveRegexError` leave the public surface after `resolve` migrates. `ResolveErrorRenderer` drops its regex special case because `InvalidRegexError` self-renders complete product vocabulary. Command registrations add `.option("--regex", "match full canonical symbol ids by JavaScript regex", false)` independently; no new CLI abstraction is needed.

**Commit plan.**

1. `test: specify symbol target regex matching` — Add failing shared-validation, backend, resolver, command-descriptor, help, and E2E coverage. Preserves TDD ordering; tests only.
2. `core: define shared regex target contracts` — Add/export `RegexSubject`, `InvalidRegexError`, and `SymbolTargetQuery`. Type definitions only; no callsites yet.
3. `core: share regex validation across navigation` — Add `compileRegex` using the shared error contract while retaining current resolve behavior through the old entry point. One validation capability only.
4. `refactor: migrate resolve to shared regex validation` — Move `resolve` to the general compiler and remove resolve-specific compiler, error, and renderer handling. Refactor only; output stays byte-identical.
5. `backend: match target queries by canonical identity` — Change backend target discovery to the discriminated query and implement full canonical-ID regex matching. One backend contract migration.
6. `cli: resolve regex symbol targets` — Build regex queries, centralize their line narrowing, and keep regex ambiguity separate from regular ranking/overload collapse. One resolver behavior change.
7. `cli: expose regex on symbol commands` — Thread the flag through four command registrations, arguments, and telemetry descriptors. One user-facing CLI surface change across shared consumers.

**Done when.** All four commands accept valid regexes and reject invalid ones consistently, multiple overload regex matches remain ambiguous, the four skipped regex rows and added edge cases pass, `resolve` behavior stays stable, and full CI parity passes.

## Phase 4 — Exact caller ownership

**Behavior delivered.** Calls inside a function-valued initializer belong to that initializer declaration in `context` callers and incoming `graph` paths. No ancestor inherits a declaration merely because it starts on the same line.

**Test cases.** Add these before production changes.

- Backend unit: `WorkspaceDeclarationIndex.declarationForNode` returns the symbol for an exact function, method, or variable declaration node.
- Backend unit: source files, statements, blocks, and other arbitrary nodes that share a declaration's start line or position return `undefined`.
- Backend unit: two declarations on one source line map to their own symbols.
- Backend integration: caller discovery attributes a nested call in an arrow-function initializer to the variable declaration. Existing nested function, branch, loop, callback, dynamic-call, and callee lookup cases remain green.
- E2E: re-enable the context caller-attribution case and graph incoming-attribution case. Assert both identify `foldedHost`, never `foldedRoot`.
- E2E: `refs` payload/output remains unchanged and carries no new enclosing-owner field.

**Components.** The declaration index exposes exact syntax-node identity, replacing its misleading line-based lookup name.

```ts
export class WorkspaceDeclarationIndex {
  declarationForNode(node: Node): SymbolOverviewNode | undefined;
}
```

`CallerFinder` continues to return the nearest callable declaration immediately, remember the nearest value declaration, and use that value only when no callable declaration encloses the call. `CalleeFinder` uses the same exact-node lookup for resolved declarations. `declarationAt(node)` is removed after both callers migrate.

**Commit plan.**

1. `test: specify exact declaration node ownership` — Add failing index, caller-integration, and re-enabled context/graph E2E regressions. Preserves TDD ordering; tests only.
2. `backend: index declarations by exact syntax node` — Add `declarationForNode` while retaining the old lookup for current callsites. New contract only; no callsites yet.
3. `backend: use exact nodes for call relationships` — Migrate caller/callee discovery and remove the line-keyed lookup. One call-relationship correction.

**Done when.** Context and graph name `foldedHost`, arbitrary same-start ancestors cannot resolve as declarations, refs remain untouched, and full CI parity passes.

## Phase 5 — Empty exact-resolve guidance

**Behavior delivered.** Empty exact `resolve` text output suggests `--fuzzy` and `--regex`. The hint is absent when either exact section has results, in fuzzy/regex modes, and in JSON output.

**Test cases.** Add these before production changes.

- Renderer unit: exact mode with zero symbols and zero files appends `No exact match; try --fuzzy for approximate names, or --regex for a pattern.`
- Renderer unit: exact mode with any symbol or file omits the hint.
- Renderer unit: empty fuzzy and regex results omit the hint.
- Renderer JSON unit: empty exact JSON remains byte-identical structured data without prose.
- E2E: re-enable the skipped empty exact-resolve case and keep existing no-match snapshots intentional.

**Components.** No result or backend contract changes. Text renderer derives the hint from existing `ResolveResult` fields.

```ts
export function renderResolveText(result: ResolveResult): string;
export function renderResolveJson(result: ResolveResult): string;
```

**Commit plan.**

1. `test: specify empty exact resolve guidance` — Add failing renderer coverage and re-enable the E2E acceptance case. Preserves TDD ordering; tests only.
2. `renderer: guide empty exact resolve results` — Append the text-only hint under the exact empty result. One renderer behavior change.

**Done when.** Empty exact text names both broader modes, all exclusion cases omit the hint, JSON stays unchanged, snapshots pass, and full CI parity passes.

## Phase 6 — Exact overview label preference

**Behavior delivered.** `overview --at` selects a unique candidate whose displayed label exactly equals the supplied text before treating longer substring matches as ambiguity. Multiple exact labels remain ambiguous; when no exact label exists, existing substring behavior remains.

**Test cases.** Add these before production changes.

- Core unit: a unique exact symbol label beats member labels that only contain it.
- Core unit: several exact displayed labels remain ambiguous.
- Core unit: no exact displayed label preserves current substring ambiguity and candidate ordering.
- Core unit: optional `--line` narrows substring candidates before exact-label preference.
- Core unit: copied full headers and fold header variants remain searchable but do not become exact displayed-label selectors.
- E2E: re-enable the bare `Greeter` case and assert the class plus requested child depth renders without treating members as competing targets.

**Components.** Selection stays inside `OverviewExpander`; request/result and renderer contracts do not change.

```ts
export class OverviewExpander {
  constructor(args: ExpandOverviewArgs);
  expand(): OverviewExpansionResult;
}
```

Exact preference compares `labelFor(candidate.node)` only after existing substring and line filtering. It does not compare line-range headers or alternate fold header variants.

**Commit plan.**

1. `test: specify exact overview label preference` — Add failing core selection tests and re-enable the overview E2E case. Preserves TDD ordering; tests only.
2. `core: prefer exact overview target labels` — Narrow multi-candidate results to exact displayed labels when available. One selection policy change.

**Done when.** Bare `Greeter` selects the class and renders its children, fallback ambiguity behavior remains stable, all overview targeting tests pass, and full CI parity passes.

## Out of scope

- Case-insensitive regex matching and ignore-case flags remain future matching-mode work.
- Fuzzy matching remains exclusive to `resolve`; symbol commands gain no fuzzy or first-result override.
- `resolve --regex` keeps its current symbol/file search scope.
- Fold-node-specific symbol-command errors remain excluded.
- Identical overview folds on one source line gain no new selector.
- Reference payloads gain no enclosing-symbol ownership, and refs output is not nested by owner.
- No new navigation commands, graph edge kinds, result formats, or source-text search behavior are added.
