# Extraction V2 and Agent-Facing Navigation Fixes

Post-v1 plan for a fold-tree `overview`, cleaned signature previews, robust extraction, suffix-pattern targets, and regex resolve, based on the recovered discussion in [`temp/recovered-session-d99673df-verbatim.md`](../../../temp/recovered-session-d99673df-verbatim.md) and the candidate note in [`temp/v2-candidates.md`](../../../temp/v2-candidates.md).

## Goal

After all phases, symnav gives agents a compact VS Code-style structural overview instead of a declaration-only dump. Headers never include JSDoc or bodies, `overview` can expand fold interiors by depth or by copied header text, symbols nested inside executable blocks are indexed with stable declaration identities, barrel files show their re-export edges, and `def`/`refs`/`context`/`graph` accept the same suffix-pattern target grammar as fully-specified canonical IDs. Extraction no longer crashes an entire project on one unrecognised AST node. `resolve` keeps its listing role and adds regex search for name families.

## Context

Today `OverviewFileSymbols` in [`packages/core/src/intermediate-representation/types.ts`](../../../packages/core/src/intermediate-representation/types.ts) exposes `symbols: readonly SymbolDecl[]`. `SymbolDecl.children` is used for class/interface/namespace members, and `assignDisambiguators` stamps same-name symbol siblings. `extractStatementDecls` in [`packages/backend-typescript/src/extract/extract-children.ts`](../../../packages/backend-typescript/src/extract/extract-children.ts) ignores executable blocks, throws on unknown statement kinds, and builds variable signatures with `decl.getText()`, which can include whole initializers. `extractSignatureSource` already cuts declarations before bodies for named declarations, but it does not own variable initializer headers. `overview` renders `SymbolDecl` trees through [`packages/renderer/src/overview/render-overview-text.ts`](../../../packages/renderer/src/overview/render-overview-text.ts), and the CLI registers only `overview <file>` with `--json`.

`resolve` in [`packages/backend-typescript/src/resolve/resolve-symbols.ts`](../../../packages/backend-typescript/src/resolve/resolve-symbols.ts) walks all `SymbolDecl.children` and matches exact own names unless `--fuzzy` is set. `def`, `refs`, `context`, and `graph` parse a canonical symbol id immediately. `WorkspaceDeclarationIndex` indexes declarations by canonical identity and declaration start line. The four skipped tests for declarations nested inside executable control-flow blocks live in backend extraction, resolve, definition, and integration suites; they need rewriting for the new fold tree because fold nodes are visible structural containers but do not contribute identity segments.

Settled design decisions from the recovered discussion:

- `overview` becomes a fold tree, not declarations-only output.
- Fold nodes are structural and identity-transparent. Canonical `SymbolIdentity` remains declaration-only.
- `SymbolDecl` and fold nodes share one overview tree through a discriminated union.
- Named symbol children render whenever their parent renders. Fold interiors cost `--depth`.
- Default overview is depth 0: signatures, class/interface members, re-export edges, and fold headers, but no bodies or JSDoc.
- Call plus trailing function literal fuses into one fold node. Its interior is the callback body.
- `--at` is the primary overview target: substring match against headers the agent saw. `--line` is only a narrowing filter.
- Ambiguous `--at`/`--line` returns candidates. No innermost-wins.
- `def`/`refs`/`context`/`graph` use one positional target grammar: suffix pattern over canonical ids. A full id is the fully-specified case.
- `resolve --regex` exists only on `resolve`, with per-segment name matching.
- Known ignored syntax is silent. Unknown syntax is skipped with a warning instead of crashing the command.
- The eval `yield_time_ms: 60000` directive belongs in `symnav-eval`, not this repository.

## Phase 1 — Extraction Crash and Input Error Hotfixes

**Behavior delivered.** A TypeScript project containing `export as namespace x;` or another unsupported top-level statement no longer kills every command. Known irrelevant syntax is skipped silently. Unknown syntax is skipped with a warning and partial results still return. Directory and extensionless file inputs produce a specific user-facing error instead of a blank extension message.

**Test cases.**

- `packages/backend-typescript/src/extract/extract-file-symbols.test.ts`: `export as namespace katex;` beside `export function render() {}` returns `render` and no warning. Level: unit. Harness: existing `parseTypeScriptSource`.
- `packages/backend-typescript/src/extract/extraction-diagnostics.test.ts`: a deliberately unhandled statement kind is reported once per kind and file, with line number. Level: unit. Harness: an extraction entrypoint with a collecting diagnostics sink.
- `apps/cli/test/e2e/overview/unsupported-input.test.ts`: `symnav overview src/rules` against a fixture directory exits 1 and prints `Cannot answer: src/rules is a directory; expected a TypeScript source file.` Level: e2e. Harness: built binary and fixture project.
- Existing overview, resolve, def, refs, context, graph e2e suites stay green with no extra stderr for known ignored syntax. Level: regression.

**Components.**

```ts
// packages/core/src/diagnostics/navigation-diagnostic.ts
export type NavigationDiagnosticSeverity = "warning";

export interface NavigationDiagnostic {
  readonly severity: NavigationDiagnosticSeverity;
  readonly message: string;
  readonly key: string;
}

export interface DiagnosticSink {
  report(diagnostic: NavigationDiagnostic): void;
}

export class CollectingDiagnosticSink implements DiagnosticSink {
  report(diagnostic: NavigationDiagnostic): void;
  diagnostics(): readonly NavigationDiagnostic[];
}
```

```ts
// packages/core/src/intermediate-representation/types.ts
export interface ResultWithDiagnostics {
  readonly diagnostics?: readonly NavigationDiagnostic[];
}
```

```ts
// packages/backend-typescript/src/extract/extraction-diagnostics.ts
export interface ReportUnrecognisedNodeArgs {
  readonly sink: DiagnosticSink;
  readonly node: Node;
  readonly filePath: string;
  readonly category: "statement" | "member";
}

export function reportUnrecognisedNode(args: ReportUnrecognisedNodeArgs): void;
```

```ts
// packages/backend-typescript/src/extract/extract-file-symbols.ts
export interface ExtractFileSymbolsArgs {
  readonly sourceFile: SourceFile;
  readonly filePath: string;
  readonly diagnostics?: DiagnosticSink;
}

export function extractFileSymbols(args: ExtractFileSymbolsArgs): OverviewFileSymbols;
```

```ts
// apps/cli/src/command.ts
export interface Command<Result, Args> {
  readonly name: string;
  describeArgs(args: Args): ArgShape;
  countResults(result: Result): Record<string, number>;
  diagnostics?(result: Result): readonly NavigationDiagnostic[];
  compute(ctx: CommandContext<Args>): Promise<Result>;
  renderText(result: Result): string;
  renderJson(result: Result): string;
}
```

`runCommand` writes each diagnostic message to stderr before stdout. Known ignored syntax includes `SyntaxKind.NamespaceExportDeclaration`. Unknown statement and member kinds report one warning per diagnostic key per command result.

**Commit plan.**

1. `test(backend): cover namespace export extraction crash` — adds the failing extraction regression for `export as namespace`. Preserves TDD ordering.
2. `test(cli): cover directory overview error` — adds the failing e2e for directory input. Preserves TDD ordering.
3. `feat(core): add navigation diagnostics contract` — adds diagnostic types and exports, with no callsites. Type-only, no callsites yet.
4. `feat(backend): skip known namespace exports` — adds `NamespaceExportDeclaration` to the known ignored syntax set. One behavior change.
5. `feat(backend): report unrecognised extraction nodes` — threads the diagnostic sink through extraction and skips unknown kinds with warnings. Uses existing diagnostics contract.
6. `fix(cli): render directory input errors explicitly` — updates input-path/backend error handling for directories and extensionless inputs. One user-facing error fix.

**Done when.** The KaTeX-style namespace export fixture no longer crashes. Unknown unsupported syntax produces one warning and partial results. Directory input prints the new deterministic error. `pnpm --filter @symnav/backend-typescript test`, `pnpm --filter symnav test`, and relevant e2e tests pass.

## Phase 2 — Collapsed Header Extraction

**Behavior delivered.** Any command that renders a symbol signature or code preview gets bounded collapsed headers. JSDoc is absent. Function, method, class, interface, type, enum, overload, and variable declarations never include executable bodies. Variable declarations with arrow functions, function expressions, object literals, array literals, call expressions, or long schema builders render the binding head only.

**Test cases.**

- `packages/backend-typescript/src/extract/extract-signature-source.test.ts`: table-driven cases assert exact collapsed header strings for function declarations, overloads, methods, accessors, constructors, classes, interfaces, type aliases, enums, namespaces, export default expressions, and declarations with attached JSDoc. Level: unit.
- `packages/backend-typescript/src/extract/extract-variable-signature.test.ts`: `const helper = () => { ... }`, `const helper = function () { ... }`, `const schema = z.object({ ... })`, `const values = [ ... ]`, `let count = 0`, and `declare const y: T` assert exact output. Level: unit.
- `packages/renderer/src/overview/render-overview-text.test.ts`: a symbol with long initializer-derived signature is not truncated by `signature-cap` because extraction never emits the body. Level: unit.
- Existing `def`, `context`, and `refs` preview snapshots are updated only where JSDoc/body leaks disappear. Level: regression.

**Components.**

```ts
// packages/backend-typescript/src/extract/extract-signature-source.ts
export function extractSignatureSource(node: Node): string;
```

```ts
// packages/backend-typescript/src/extract/extract-variable-signature.ts
export interface ExtractVariableSignatureArgs {
  readonly statement: VariableStatement;
  readonly declaration: VariableDeclaration;
}

export function extractVariableSignature(args: ExtractVariableSignatureArgs): string;
```

Header rules:

- JSDoc and leading comments are not part of a signature.
- Declarations with bodies stop before the body.
- Variables include modifiers, declaration keyword, name, type annotation when present, and a bounded initializer head when useful.
- Function-valued variables render enough to show call shape, not implementation.
- Object, array, call, and literal initializers do not dump their contents.

**Commit plan.**

1. `test(backend): specify collapsed declaration headers` — adds table tests for declaration headers and JSDoc removal. Tests first.
2. `test(backend): specify variable signature headers` — adds failing variable initializer body-leak cases. Tests first.
3. `refactor(backend): move variable signature extraction` — extracts the variable signature helper into its own module without behavior change. Pure move/refactor, no behavior change.
4. `fix(backend): collapse declaration headers without docs` — updates `extractSignatureSource` to satisfy declaration tests. One logical behavior.
5. `fix(backend): collapse variable initializer headers` — updates variable signature extraction to satisfy initializer tests. One logical behavior.

**Done when.** Header table tests pass. No command output includes JSDoc or full function/object bodies in signatures. Existing suites pass after intentional snapshot updates.

## Phase 3 — Overview Tree IR

**Behavior delivered.** Core can represent one overview tree containing addressable symbols and identity-transparent fold nodes. Declaration-only commands continue to see only symbols. Overview JSON has a discriminant per node, so consumers can tell symbols from folds.

**Test cases.**

- `packages/core/src/intermediate-representation/overview-tree.test.ts`: symbol and fold nodes share `range`, `header`, and `children`; only symbol nodes have `identity` and `kind`. Level: unit.
- `packages/core/src/intermediate-representation/walk-symbols.test.ts`: walking an overview tree returns all nested symbols and skips fold nodes while descending through them. Level: unit.
- `packages/core/src/intermediate-representation/assign-disambiguators.test.ts`: same-name symbols in sibling scope get source-order `#N`; fold siblings do not receive disambiguators and do not affect counts. Level: unit.
- `packages/renderer/src/overview/render-overview-json.test.ts`: JSON contains `type: "symbol"` or `type: "fold"` for each entry. Level: unit.
- Existing resolve/def/refs/context/graph tests stay green through the symbol-only walker. Level: regression.

**Components.**

```ts
// packages/core/src/intermediate-representation/overview-tree.ts
export type OverviewNode = SymbolOverviewNode | FoldOverviewNode | ReExportOverviewNode;

export interface OverviewNodeBase {
  readonly range: LineRange;
  readonly header: Signature;
  readonly children: readonly OverviewNode[];
}

export interface SymbolOverviewNode extends OverviewNodeBase {
  readonly type: "symbol";
  readonly identity: SymbolIdentity;
  readonly kind: SymbolKind;
}

export type FoldKind =
  | "call"
  | "block"
  | "loop"
  | "conditional"
  | "switch"
  | "try"
  | "catch"
  | "finally"
  | "callback";

export interface FoldOverviewNode extends OverviewNodeBase {
  readonly type: "fold";
  readonly foldKind: FoldKind;
}

export interface ReExportOverviewNode extends OverviewNodeBase {
  readonly type: "re-export";
  readonly exportKind: "named" | "namespace" | "star";
  readonly exportedNames: readonly string[];
  readonly sourceModule: string | undefined;
}

export interface OverviewFileSymbols extends ResultWithDiagnostics {
  readonly file: string;
  readonly entries: readonly OverviewNode[];
}

export function walkOverviewSymbols(entries: readonly OverviewNode[]): readonly SymbolOverviewNode[];
```

```ts
// packages/core/src/intermediate-representation/types.ts
export type SymbolDecl = SymbolOverviewNode;
```

This phase may keep `symbols` as a deprecated alias only if needed for a smaller migration, but the end state is `entries`.

**Commit plan.**

1. `test(core): specify overview tree node model` — adds failing overview-tree and symbol-walker tests. Tests first.
2. `feat(core): add overview node union` — adds type definitions and exports without replacing callsites. Type-only, no callsites yet.
3. `feat(core): add overview symbol walker` — adds the declaration-only traversal helper. One utility.
4. `refactor(core): disambiguate only symbol overview nodes` — adapts disambiguator tests and implementation without fold extraction yet. Refactor only against new model.
5. `refactor(renderer): render discriminated overview JSON` — updates JSON renderer for `entries`. One renderer contract change.
6. `refactor(backend): return symbol overview entries` — adapts extraction to emit `SymbolOverviewNode` entries while preserving text behavior. Uses the new type after it exists.

**Done when.** Overview JSON has discriminated entries. Text output for files with declarations only is intentionally unchanged except for signature cleanup from Phase 2. Declaration-only commands still resolve the same symbols.

## Phase 4 — Fold Extraction, Re-Export Edges, and Default Overview

**Behavior delivered.** `overview <file>` renders a compact fold tree at depth 0. It shows top-level declarations, class/interface members, top-level calls with trailing callback bodies folded, control-flow/block fold headers, and re-export edges in barrel files. It indexes named declarations nested behind fold nodes with stable declaration identities, but fold nodes do not contribute identity segments.

**Test cases.**

- Rewrite the four skipped “declarations nested inside executable control-flow blocks” tests across extraction, resolve, definition, and integration. Assertions check both the fold-node placement and canonical identity flattening, for example `input.ts::outer::insideIf`. Level: unit and integration.
- `packages/backend-typescript/src/extract/fold-tree-extraction.test.ts`: `describe("x", () => { const helper = () => {}; })` emits one fused call fold with `helper` inside its children. Level: unit.
- Same file: `if`, `for`, `for-of`, `for-in`, `while`, `switch`, `try/catch/finally`, bare block, and nested callbacks emit fold nodes with bounded headers and nested symbols. Level: unit.
- Same file: plain calls without foldable arguments render as call folds only when they are top-level structural statements; no call expression becomes a symbol. Level: unit.
- Same file: `export * from "./core";`, `export { A, B as C } from "./api";`, and `export * as ns from "./ns";` emit re-export entries without loading target files. Level: unit.
- `apps/cli/test/e2e/overview/fold-tree.test.ts`: default overview against a fixture shows collapsed headers and no body lines. Level: e2e.
- `packages/backend-typescript/src/resolve/resolve-symbols.test.ts`: nested declarations inside folds resolve by name and by full canonical id. Level: unit.

**Components.**

```ts
// packages/backend-typescript/src/extract/fold-node-kind.ts
export function foldKindOf(node: Node): FoldKind | undefined;
```

```ts
// packages/backend-typescript/src/extract/extract-fold-header.ts
export function extractFoldHeader(node: Node): Signature;
```

```ts
// packages/backend-typescript/src/extract/extract-overview-children.ts
export interface ExtractOverviewChildrenArgs {
  readonly nodes: readonly Node[];
  readonly scope: ExtractionScope;
  readonly diagnostics: DiagnosticSink;
}

export function extractOverviewChildren(args: ExtractOverviewChildrenArgs): readonly OverviewNode[];
```

```ts
// packages/backend-typescript/src/extract/extract-re-export-entry.ts
export function extractReExportEntry(node: Node, filePath: string): ReExportOverviewNode | undefined;
```

```ts
// packages/backend-typescript/src/extract/extraction-scope.ts
export interface ExtractionScope {
  readonly file: string;
  readonly symbolSegments: readonly SymbolPathSegment[];
}

export function childSymbolScope(parent: ExtractionScope, name: string): ExtractionScope;
export function transparentScope(parent: ExtractionScope): ExtractionScope;
```

Fold extraction rules:

- Function and method bodies are fold interiors.
- Call expressions with trailing function literals fuse call and callback into one fold node. The fold header is the call header, and children come from the callback body.
- Blocks, loops, conditionals, switch cases, and try/catch/finally are fold nodes with transparent identity scope.
- Named declarations inside transparent folds receive canonical ids based on the nearest named declaration ancestors.
- Re-export entries are single-file edges. They do not inline target symbols.

**Commit plan.**

1. `test(backend): specify fold extraction fixtures` — adds fold tree fixture tests. Tests first.
2. `test(backend): rewrite block-scoped declaration tests` — rewrites skipped tests around fold nodes and identity flattening. Tests first.
3. `test(backend): specify barrel re-export entries` — adds failing re-export edge tests. Tests first.
4. `feat(backend): add extraction scope helpers` — introduces symbol and transparent scope helpers without callsites. Type/helper-only.
5. `feat(backend): extract fold overview nodes` — adds fold-node extraction and fused call/callback behavior. One capability.
6. `feat(backend): extract re-export overview entries` — adds barrel edge extraction. One capability.
7. `refactor(backend): walk overview symbols for resolve and definitions` — replaces `SymbolDecl.children` assumptions with `walkOverviewSymbols`. Refactor only after fold extraction exists.
8. `feat(renderer): render default fold overview` — updates text renderer for fold and re-export nodes at default depth. Renderer behavior only.

**Done when.** Default overview no longer returns empty for test files or barrels that contain foldable structure/re-export edges. Nested declarations in executable blocks resolve and define correctly. Fold nodes render but never appear in `resolve` results as symbols.

## Phase 5 — Overview Depth and Targeted Expansion

**Behavior delivered.** `overview` can expand fold interiors predictably. `--depth` controls how many fold interiors open. `--at` targets fold or symbol headers by copied substring. `--line` narrows matches but never silently selects an innermost node. Ambiguous targets print candidates and exit as a user-facing error. Shared-line and minified-like files remain addressable by header text and pattern targets.

**Test cases.**

- `packages/core/src/overview/overview-expansion.test.ts`: depth 0 renders named symbol children and fold headers; depth 1 opens one fold interior; depth 2 opens nested fold interiors. Level: unit.
- Same file: symbol children of rendered symbols are free and do not consume depth. Level: unit.
- Same file: `--at "describe(\"cursor\")"` selects the matching fold by header substring. Level: unit.
- Same file: `--line` alone with multiple matches returns candidates rather than picking one. Level: unit.
- Same file: `--at` plus `--line` narrows candidate set; zero match gives not-found; multiple gives candidates. Level: unit.
- Same file: two folds on one source line are ambiguous under `--line` and unique under a longer `--at`. Level: unit.
- `apps/cli/test/e2e/overview/overview-targeting.test.ts`: collapsed overview, copied header expansion, candidate error, and JSON output. Level: e2e.
- `apps/cli/test/e2e/overview/minified-line-guard.test.ts`: a single-line fixture with many fold nodes rejects `--line 1` with a self-explaining error and succeeds with `--at`. Level: e2e.

**Components.**

```ts
// packages/core/src/overview/overview-query.ts
export interface OverviewExpansionRequest {
  readonly depth: number;
  readonly at: string | undefined;
  readonly line: number | undefined;
}

export interface OverviewExpansionCandidate {
  readonly header: string;
  readonly range: LineRange;
  readonly node: OverviewNode;
}

export interface OverviewExpansionResult {
  readonly file: string;
  readonly entries: readonly OverviewNode[];
  readonly request: OverviewExpansionRequest;
  readonly diagnostics?: readonly NavigationDiagnostic[];
}

export class AmbiguousOverviewTargetError extends UserFacingError {
  constructor(candidates: readonly OverviewExpansionCandidate[]);
}

export class OverviewTargetNotFoundError extends UserFacingError {
  constructor(request: OverviewExpansionRequest);
}

export class AmbiguousLineTargetError extends UserFacingError {
  constructor(line: number);
}
```

```ts
// packages/core/src/overview/overview-expander.ts
export interface ExpandOverviewArgs {
  readonly file: OverviewFileSymbols;
  readonly request: OverviewExpansionRequest;
}

export class OverviewExpander {
  constructor(args: ExpandOverviewArgs);
  expand(): OverviewExpansionResult;
}
```

```ts
// apps/cli/src/commands/overview/overview-command.ts
export interface OverviewArgs {
  readonly file: string;
  readonly depth: number;
  readonly at: string | undefined;
  readonly line: number | undefined;
}
```

`registerOverviewCommand` adds `--depth <n>`, `--at <text>`, and `--line <n>`. The default depth is 0. `--at` matches header text as rendered without tree glyphs. Candidate lists include header and range.

**Commit plan.**

1. `test(core): specify overview depth expansion` — adds failing depth tests. Tests first.
2. `test(core): specify overview target candidates` — adds failing `--at`/`--line` candidate tests. Tests first.
3. `feat(core): add overview expansion request model` — adds request/result/error types, no callsites. Type-only.
4. `feat(core): add OverviewExpander` — implements depth and target selection. One capability.
5. `feat(cli): parse overview depth and target flags` — wires CLI args into `OverviewArgs`. CLI surface only.
6. `feat(cli): apply overview expansion before rendering` — computes file symbols then expands according to request. Uses existing expander.
7. `feat(renderer): render overview target candidate errors` — ensures candidate errors follow project error style. One behavior.

**Done when.** Agents can run `overview src/file.ts --at 'describe("x")' --depth 1` and get only that expanded region. Ambiguous requests show candidates. Line-only targeting never silently picks among same-line nodes.

## Phase 6 — Suffix-Pattern Target Grammar

**Behavior delivered.** `def`, `refs`, `context`, and `graph` accept one target grammar: a suffix pattern over canonical ids. Full canonical ids still work. Bare names work when unique. Partial file paths and partial segment paths narrow the match. Ambiguity stops and shows full canonical ids with snippets. Zero matches produce the existing user-facing not-found style with the queried pattern.

**Test cases.**

- `packages/core/src/target/symbol-target-pattern.test.ts`: parses `charge`, `orders.ts::charge`, and `src/orders.ts::PaymentProcessor::charge` as target patterns; full canonical ids remain valid patterns. Level: unit.
- Same file: path suffix matching and segment suffix matching choose expected candidates. Level: unit.
- Same file: same-name candidates produce an `AmbiguousSymbolTargetError` with full ids and signatures. Level: unit.
- `packages/backend-typescript/src/target/typescript-symbol-target-resolver.test.ts`: resolver walks all symbols through fold nodes and returns only declarations. Level: unit.
- `apps/cli/test/e2e/def/pattern-target.test.ts`: `symnav def helper` succeeds when unique; ambiguous `symnav def parse` lists candidates; copied candidate id succeeds. Level: e2e.
- Equivalent focused e2e coverage for `refs`, `context`, and `graph` proves they share the same resolver seam, not four implementations. Level: e2e.
- Regression: existing `resolve -> def <full-id>` pipeline still succeeds byte-for-byte for full ids. Level: e2e.

**Components.**

```ts
// packages/core/src/target/symbol-target-pattern.ts
export interface SymbolTargetPattern {
  readonly raw: string;
  readonly fileSuffix: string | undefined;
  readonly segmentSuffix: readonly SymbolPathSegment[];
}

export function parseSymbolTargetPattern(raw: string): SymbolTargetPattern;
export function symbolTargetMatches(pattern: SymbolTargetPattern, identity: SymbolIdentity): boolean;
```

```ts
// packages/core/src/target/symbol-target-result.ts
export interface SymbolTargetCandidate {
  readonly symbol: SymbolDecl;
  readonly canonicalId: string;
  readonly signature: Signature;
}

export class SymbolTargetNotFoundError extends UserFacingError {
  constructor(pattern: SymbolTargetPattern);
}

export class AmbiguousSymbolTargetError extends UserFacingError {
  constructor(pattern: SymbolTargetPattern, candidates: readonly SymbolTargetCandidate[]);
}
```

```ts
// packages/core/src/backend/language-backend.ts
export interface ResolveSymbolTargetOptions {
  readonly line: number | undefined;
}

export interface LanguageBackend {
  resolveSymbolTarget(
    files: readonly ResolvedPath[],
    pattern: SymbolTargetPattern,
    options: ResolveSymbolTargetOptions,
  ): Promise<SymbolDecl>;
}
```

```ts
// apps/cli/src/commands/resolve-symbol-target.ts
export interface ResolveSymbolTargetForCommandArgs {
  readonly workspace: Workspace;
  readonly router: BackendRouter;
  readonly cwd: string;
  readonly rawTarget: string;
  readonly line: number | undefined;
}

export async function resolveSymbolTargetForCommand(
  args: ResolveSymbolTargetForCommandArgs,
): Promise<SymbolDecl>;
```

Command arg names change from `symbolId` to `target` in `def`, `refs`, `context`, and `graph`, but telemetry continues to record only argument shape. `--line` is accepted by these commands as a narrowing filter for usage-position workflows, not as part of identity.

**Commit plan.**

1. `test(core): specify symbol target pattern matching` — adds parse/match/ambiguity tests. Tests first.
2. `test(cli): cover pattern targets on def` — adds failing def e2e for unique, ambiguous, and full-id targets. Tests first.
3. `feat(core): add symbol target pattern model` — type and parser only, no command callsites. Type-only.
4. `feat(core): add symbol target errors` — adds user-facing error classes for not-found and ambiguity. Type/error-only.
5. `feat(backend-typescript): resolve symbol target patterns` — implements backend target resolution over overview symbols. One backend capability.
6. `refactor(cli): share target resolution helper` — adds `resolveSymbolTargetForCommand` without changing command behavior. Refactor seam only.
7. `feat(cli): accept pattern targets in def` — wires `def` to the shared resolver. One command behavior.
8. `feat(cli): accept pattern targets in refs` — wires `refs`. One command behavior.
9. `feat(cli): accept pattern targets in context` — wires `context`. One command behavior.
10. `feat(cli): accept pattern targets in graph` — wires `graph`. One command behavior.

**Done when.** Full ids, bare names, and suffix patterns work consistently across declaration-targeted commands. Ambiguous targets teach the agent the canonical ids to copy. No fold node is ever accepted as a command target.

## Phase 7 — Regex Resolve

**Behavior delivered.** `resolve --regex <pattern>` lists symbols whose own name matches the regex. Regex search is only for `resolve`; commands that need a single target continue to use suffix-pattern matching and ambiguity candidates.

**Test cases.**

- `packages/backend-typescript/src/resolve/resolve-symbols.test.ts`: `--regex '^to[A-Z].*'` matches converter symbols; regex applies to own symbol name, not the full canonical id string. Level: unit.
- Same file: invalid regex returns a user-facing error. Level: unit.
- Same file: `--regex` and `--fuzzy` together are rejected as conflicting search modes. Level: unit.
- `apps/cli/test/e2e/resolve/regex.test.ts`: text and JSON output for regex resolve. Level: e2e.
- Existing exact and fuzzy resolve tests remain unchanged. Level: regression.

**Components.**

```ts
// packages/core/src/backend/language-backend.ts
export type ResolveSymbolsMode = "exact" | "fuzzy" | "regex";

export interface ResolveSymbolsOptions {
  readonly mode: ResolveSymbolsMode;
}
```

```ts
// packages/core/src/backend/errors.ts
export class InvalidResolveRegexError extends UserFacingError {
  constructor(pattern: string, reason: string);
}
```

```ts
// apps/cli/src/commands/resolve/resolve-command.ts
export interface ResolveArgs {
  readonly query: string;
  readonly mode: ResolveSymbolsMode;
}
```

`resolve` keeps being the explicit candidate-listing command. Internally it can share the same symbol collection path as target resolution, but it does not auto-proceed.

**Commit plan.**

1. `test(backend): specify regex resolve` — adds failing backend regex tests. Tests first.
2. `test(cli): cover resolve regex mode` — adds failing e2e output tests. Tests first.
3. `feat(core): model resolve search modes` — changes options type from `fuzzy: boolean` to mode, with callsites still compile-failing until next commit. Type-only.
4. `refactor(cli): pass resolve mode` — maps existing exact/fuzzy flags to the new mode. Refactor existing behavior.
5. `feat(backend): match resolve regex by symbol name` — adds regex matching and invalid-regex errors. One capability.
6. `feat(cli): add resolve --regex` — exposes the flag and conflict validation. CLI behavior only.

**Done when.** `symnav resolve --regex '^use[A-Z]'` works. `--regex` does not affect `def`, `refs`, `context`, or `graph`. Exact and fuzzy resolve behavior remains covered.

## Phase 8 — Symnav Skill and Agent Guidance

**Behavior delivered.** The repo's `symnav` skill is updated after the CLI changes land, so agents learn the new target grammar, overview depth/targeting model, regex resolve, and warning behavior only once those commands exist. Agents are steered toward copying candidates, using `--at` for overview expansion, and passing long `yield_time_ms` when invoking symnav in environments where tool calls yield early.

**Test cases.**

- `meta-tests/` or docs tests, if present for AGENTS/skills, are extended to assert `.agents/skills/symnav/SKILL.md` mentions suffix-pattern targets, `overview --depth`, `overview --at`, `resolve --regex`, and `yield_time_ms: 60000`. Level: meta/unit if existing; otherwise no automated doc test.
- Manual docs check: examples in `.agents/skills/symnav/SKILL.md` match the implemented CLI help. Level: manual.
- Regression check: before Phase 8 lands, the active skill still describes the currently shipped command surface, so agents are not instructed to use unimplemented flags. Level: manual.

**Components.**

```md
<!-- .agents/skills/symnav/SKILL.md -->
target = suffix of a canonical id:
  def charge
  def orders.ts::charge
  def src/orders.ts::PaymentProcessor::charge
Unique targets proceed. Ambiguous targets print candidates; copy one.

overview:
  overview src/file.ts
  overview src/file.ts --depth 1
  overview src/file.ts --at 'describe("cursor pagination")' --depth 2

resolve:
  resolve --regex '^to[A-Z].*'
```

The eval directive itself is external:

```md
<!-- /Users/moyaseen/projects/symnav-eval injected /app/AGENTS.md -->
Always pass yield_time_ms: 60000 on every exec_command call.
Do not treat empty output from an early yield as the command result.
```

**Commit plan.**

1. `test(meta): pin symnav skill command examples` — adds docs/meta assertions if the repo has a matching pattern. Tests first when available.
2. `docs: update symnav skill for overview v2` — updates `.agents/skills/symnav/SKILL.md` for `--depth`, `--at`, suffix targets, regex resolve, warning behavior, and the 60-second exec-yield guidance. Docs only, after implementation phases.
3. `docs: update README examples for navigation targets` — updates user-facing examples to match the same command surface. Docs only.

**Done when.** A fresh agent reading the skill sees one target grammar, understands copied-header overview expansion, and knows to use a 60-second exec yield for symnav in Codex-style evals. README and help examples do not contradict the implemented CLI.

## Out of Scope

- Daemon or persistent index. It remains the long-term fix for cold-start latency, but this plan only documents the eval-side `yield_time_ms` instruction.
- Editing `/Users/moyaseen/projects/symnav-eval` from this repo plan. The controlled 60-second directive should land in the eval repo as its own change.
- Inlining re-exported target symbols into barrel overviews. This plan shows re-export edges only.
- Test-runner-aware entries such as `it("name")` as symbols. They appear as fold headers, not canonical symbols.
- Character-offset or column targeting. Agents should copy header text with `--at`; `--line` is only a narrowing filter.
- `--funcs`, `--class`, `--type`, `--var`, `--enum` filters. The transcript raised them as possible future granularity, but no final design was settled.
- Making fold/call nodes valid targets for `def`, `refs`, `context`, or `graph`. Position and header text are query inputs; retained identities remain declaration-only.
- Changing `resolve` into an auto-proceeding command. It remains the candidate-listing/search command.
