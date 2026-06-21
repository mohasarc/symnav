# Stage 4 — `context` — Phased Plan

`symnav context <symbol-id>`: one compact block per symbol — definition, direct callers, direct callees, a reference summary, and recent git history.

Source: [`plans/000/symnav-stages.md`](../symnav-stages.md) Stage 4. Behavior contract: [`plans/000/symnav-functional-spec.md`](../symnav-functional-spec.md) `context` section.

## Goal

After all phases, `symnav context <symbol-id>` resolves a single concrete symbol and prints five sections: its definition, up to 20 direct callers (with the call-site line), up to 20 direct callees (with each callee's signature), a reference-count summary pointing at `refs`, and up to 5 recent commits touching the symbol's line range. Overflow past the cap points at `graph`. Empty sections still render. `--json` emits the same data structured. Callers/callees count only statically-resolved calls to workspace, non-ignored files; possible/dynamic edges are dropped (surfaced later by `graph`). Telemetry records one shape-only event through the existing `runCommand` seam. The six commands' output is unchanged.

## Context

**Command pipeline.** `apps/cli/src/command.ts` defines `Command<Result, Args>` (`name`, `describeArgs`, `countResults`, `compute`, `renderText`, `renderJson`) and `runCommand`, which builds the `Workspace` + `BackendRouter`, calls `compute`, records telemetry, then renders. `CommandContext<Args>` carries `workspace`, `router`, `cwd`, `args`. Registration mirrors `apps/cli/src/commands/refs/register-refs-command.ts`; commands wire in `apps/cli/src/program.ts`. `ProgramDependencies` (`apps/cli/src/program-dependencies.ts`) is built in `program.ts:defaultDependencies()` — already constructs a `NodeGitRemoteReader` (git is shelled there today via the telemetry identity path).

**Backend.** `LanguageBackend` (`packages/core/src/backend/language-backend.ts`) exposes `accepts`, `fileSymbols`, `resolveSymbols`, `findDefinitions`, `findReferences`. The TS backend (`packages/backend-typescript/src/typescript-backend/typescript-backend.ts`) delegates to `findDefinitions(...)`, `new ReferenceFinder(...).find()`, etc. `DeclarationLocator` (`packages/backend-typescript/src/identity/locate-declarations.ts`) maps a `SymbolIdentity` to `LocatedDeclaration { declaration: SymbolDecl, node: Node }` — the reuse point for walking a symbol's body and building `SymbolDecl`s for related symbols. `classify-reference-kind.ts` classifies reference nodes. `SymbolNotFoundError` (core) is thrown by `ReferenceFinder` when no declaration matches; `findDefinitions` returns `[]` instead of throwing.

**IR.** `packages/core/src/intermediate-representation/`: `SymbolDecl` (`identity`, `kind {role, nativeLabel}`, `range`, `signature {startLine, lines[]}`, `children`), `SymbolReference` (`file`, `line`, `previewSource`, `matchStart`, `matchEnd`, `kind`), `ReferenceKind = "usage"|"import"|"export"|"type"`, `SymbolIdentity {file, segments[]}`. `RefsResultBuilder` holds private `countKinds` and `compareReferences`. `parseSymbolIdentity` / `formatSymbolIdentity` in `canonical-identity.ts`. `Paginator` + `DEFAULT_PAGE_SIZE` in `pagination/`.

**Renderer.** `packages/renderer/src/`: `shared/render-format.ts` (`formatRange`, `formatHeadLine`, `formatIdentityPath`, `treeGlyphsFor`). `definition/` renders the file-grouped definition tree and `definition-tag.ts` maps `nativeLabel` → `implementation`/`declaration`/`overload`. `refs/reference-tree.ts` builds a path trie with single-child directory collapsing (`buildReferenceTree`, `collapseInto`); `refs/render-refs-text.ts` renders the header (`Total`/`Kinds`/`Page`/`Sort`) and tree. `KIND_ORDER` lives there.

**Tests.** Vitest. Unit colocated `*.test.ts`; backend integration under `packages/backend-typescript/test/integration/`; e2e under `apps/cli/test/e2e/` spawning the built binary. Fixtures under `packages/testing/fixtures/`, resolved via `fixturePath("name")`; a fixture's git lives as `dot-git/`, renamed by `ensureFixtureGitMarker`.

---

## Phase 1 — Target resolution primitive

**Behavior delivered.** The backend can resolve a `SymbolIdentity` to the single concrete symbol `context` will describe, or report that the identity is ambiguous (multiple implementations) or missing. Overloads collapse to their implementation; a declaration-only symbol resolves to its declaration. No CLI surface yet.

**Test cases.**
- Plain function identity → `{ outcome: "resolved", target }` with the function's range. *(integration, backend; fixture `call-graph-cases`)*
- Overloaded method identity (signatures + implementation) → `resolved`, `target` is the implementation declaration (multi-line range). *(integration)*
- Interface method with two concrete implementations → `{ outcome: "ambiguous", candidates }` listing both implementation decls. *(integration)*
- Declaration-only symbol (interface method, no implementation in workspace) → `resolved`, `target` is the declaration. *(integration)*
- Identity matching nothing → `{ outcome: "not-found" }`. *(integration)*
- Fixture work: `call-graph-cases` project containing a plain function, an overloaded method, an interface with two implementers, and a declaration-only interface method.

**Components.**

```ts
// packages/core/src/intermediate-representation/call-target.ts
export type CallTargetResolution =
  | { readonly outcome: "resolved"; readonly target: SymbolDecl }
  | { readonly outcome: "ambiguous"; readonly candidates: readonly SymbolDecl[] }
  | { readonly outcome: "not-found" };
```

```ts
// packages/core/src/backend/language-backend.ts (addition)
findCallTarget(
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<CallTargetResolution>;
```

Algorithm (prose): reuse `DeclarationLocator` to find declarations matching the identity. Of those, the implementations are the decls carrying a body (TS-specific knowledge stays in the backend). Zero matches → `not-found`. More than one implementation across the matches → `ambiguous` with those implementations as candidates. Otherwise → `resolved` with the implementation, or the declaration when there is no implementation.

**Commit plan.**
1. `test: resolve call target across plain/overloaded/contract/missing` — backend integration tests + `call-graph-cases` fixture; red. *(tests first)*
2. `feat(core): add CallTargetResolution` — type + index export, no callers. *(type-only)*
3. `feat(core): add findCallTarget to LanguageBackend` — interface method + TS backend implementation. *(first use of the type; one logical capability)*

**Done when.** All five resolution tests green. `CallTargetResolution` exported from `@symnav/core`. CI green.

---

## Phase 2 — Callees primitive

**Behavior delivered.** The backend lists a symbol's direct callees — the functions/methods/constructors its body calls — as call edges, each carrying the callee `SymbolDecl`, every call site, and a confidence. Calls to non-workspace or ignored files are dropped; unresolved/dynamic targets are tagged `possible`.

**Test cases.**
- Symbol whose body calls two cross-file functions → two `certain` edges, each with the callee's `SymbolDecl` (signature present) and one site. *(integration; `call-graph-cases`)*
- Body calling the same callee on two lines → one edge with `sites.length === 2`, sites sorted by line. *(integration)*
- Body with `new Foo()` where `Foo` has a constructor → edge whose `symbol` is `Foo::constructor`; when `Foo` declares none → edge whose `symbol` is the class `Foo`. *(integration)*
- Body calling a `node_modules`/lib symbol → that call produces no edge. *(integration)*
- Body with dynamic dispatch (`table[key]()`) → `possible` edge with a `reason`. *(integration)*
- Recursive symbol (calls itself) → a self-edge is present. *(integration)*
- Symbol with an empty/expression-free body → no edges (`[]`). *(integration)*

**Components.**

```ts
// packages/core/src/intermediate-representation/call-edge.ts
export type EdgeConfidence = "certain" | "possible";

export interface CallSite {
  readonly file: string;          // workspace-relative, POSIX
  readonly line: number;          // 1-based
  readonly previewSource: string; // full source line
  readonly matchStart: number;
  readonly matchEnd: number;
}

export interface CallEdge {
  readonly symbol: SymbolDecl;          // the callee (this phase) or caller (Phase 3)
  readonly sites: readonly CallSite[];  // >= 1, sorted by file then line
  readonly confidence: EdgeConfidence;
  readonly reason?: string;             // set when confidence === "possible"
}
```

```ts
// packages/core/src/backend/language-backend.ts (addition)
findCallees(
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly CallEdge[]>;
```

Algorithm (prose): locate the implementation node via `DeclarationLocator`. Collect call/new expressions inside its body. Resolve each callee declaration through ts-morph; drop targets outside the enumerated workspace files. Build a `SymbolDecl` for each callee (reuse the overview extraction keyed by the callee's identity) and group multiple call sites to the same callee into one edge. Statically-resolved → `certain`; element-access/unresolved calls → `possible` with a reason. Returns every edge (no cap, no confidence filter) — shaping is the consumer's job.

**Commit plan.**
1. `test: discover direct callees with sites, constructors, drops, possibles` — backend integration tests extending `call-graph-cases`; red. *(tests first)*
2. `feat(core): add CallEdge and CallSite` — types + index exports, no callers. *(type-only)*
3. `feat(core): add findCallees to LanguageBackend` — interface method + TS implementation. *(first use of the types)*

**Done when.** Callee tests green; constructor, drop-external, possible-tag, multi-site, and recursion cases all asserted. `CallEdge`/`CallSite` exported. CI green.

---

## Phase 3 — Callers primitive

**Behavior delivered.** The backend lists a symbol's direct callers — the enclosing named symbols that call it — as call edges in the same shape, each mapped up from its call sites to the calling symbol.

**Test cases.**
- Symbol called from two different files → two `certain` edges; `symbol` is each caller's enclosing declaration, preview site is the call line. *(integration; `call-graph-cases`)*
- One caller that calls the target twice → one edge, `sites.length === 2`. *(integration)*
- Caller in a test file → included (no filtering). *(integration)*
- Symbol with no callers → `[]`. *(integration)*
- Reference that is an import/type-only mention, not a call → produces no caller edge. *(integration)*
- Dynamic-dispatch caller → `possible` edge with a `reason`. *(integration)*

**Components.**

```ts
// packages/core/src/backend/language-backend.ts (addition)
findCallers(
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly CallEdge[]>;
```

Algorithm (prose): enumerate references to the identity (reuse the `ReferenceFinder` machinery but keep nodes). Keep only references in call position; for each, walk ancestors to the nearest enclosing named declaration, build its `SymbolDecl`, and group call sites by enclosing symbol into one edge. Statically-resolved call positions → `certain`; dynamic dispatch → `possible` with a reason. Returns every edge unfiltered/uncapped.

**Commit plan.**
1. `test: discover direct callers mapped to enclosing symbols` — backend integration tests; red. *(tests first)*
2. `feat(core): add findCallers to LanguageBackend` — interface method + TS implementation. *(reuses CallEdge from Phase 2)*

**Done when.** Caller tests green; multi-site, test-file, non-call-reference exclusion, and zero-caller cases asserted. CI green.

---

## Phase 4 — Git-history port

**Behavior delivered.** `core` defines a `GitHistory` port; `apps/cli` provides a node implementation that runs `git log -L` for a file's line range and returns up to a limit of commits. All git failures (not a repo, untracked file, git missing, range moved) yield `[]`, never throw. The port reaches commands through `CommandContext`; no command consumes it yet.

**Test cases.**
- `NodeGitHistory` against a fixture with a frozen `dot-git`: querying a symbol's line range returns its commits as `{ sha, date, author, subject }`, newest first, capped at `limit`. *(integration; fixture `context-history-cases` with `dot-git/`)*
- Untracked/uncommitted file → `[]`. *(integration)*
- Directory that is not a git repo → `[]`. *(integration)*
- `git` binary failing/absent (port given a failing spawn) → `[]`. *(unit, `NodeGitHistory` with injected failing exec)*
- `runCommand` populates `ctx.git` from `dependencies.git` and existing commands ignore it — overview/refs/def output byte-identical. *(e2e regression, existing snapshots)*

**Components.**

```ts
// packages/core/src/git/git-history.ts
export interface HistoryEntry {
  readonly sha: string;     // short sha
  readonly date: string;    // YYYY-MM-DD
  readonly author: string;
  readonly subject: string;
}

export interface RecentHistoryQuery {
  readonly workspaceRoot: string;
  readonly file: string;    // workspace-relative, POSIX
  readonly range: LineRange;
  readonly limit: number;
}

export interface GitHistory {
  recentHistory(query: RecentHistoryQuery): Promise<readonly HistoryEntry[]>;
}
```

```ts
// apps/cli/src/git/node-git-history.ts
export class NodeGitHistory implements GitHistory {
  recentHistory(query: RecentHistoryQuery): Promise<readonly HistoryEntry[]>;
}

// apps/cli/src/command.ts — CommandContext gains:
readonly git: GitHistory;

// apps/cli/src/program-dependencies.ts — ProgramDependencies gains:
git: GitHistory;
```

Algorithm (prose): `NodeGitHistory` runs `git log -L <start>,<end>:<file> --no-patch --format=<sha|date|author|subject>` with `cwd = workspaceRoot`, parses the formatted lines into `HistoryEntry`, slices to `limit`. Any non-zero exit, spawn error, or parse miss returns `[]`. `runCommand` sets `ctx.git = dependencies.git`.

**Commit plan.**
1. `test: read bounded git history and swallow failures` — `NodeGitHistory` unit + integration, `context-history-cases` fixture with `dot-git/`; red. *(tests first)*
2. `feat(core): add GitHistory port` — types only, no implementation/callers. *(type-only)*
3. `feat(cli): add NodeGitHistory implementation` — node adapter alone. *(new code, no wiring)*
4. `feat(cli): thread GitHistory through dependencies and context` — add `git` to `ProgramDependencies` + `defaultDependencies`, add `git` to `CommandContext`, set it in `runCommand`, update the dependency test helper. *(wiring only, no behavior change to existing commands)*

**Done when.** Git unit + integration tests green; frozen-`dot-git` snapshot stable; failure modes all return `[]`. Existing e2e snapshots unchanged. CI green.

---

## Phase 5 — `ContextResult` model and builder

**Behavior delivered.** `core` can assemble a `ContextResult` from raw definitions, caller/callee edges, references, and history: edges filtered to `certain`, sorted, capped at 20 with an overflow count; references reduced to total + per-kind counts. Pure data assembly, unit-tested.

**Test cases.**
- `countReferenceKinds` returns the same counts `RefsResultBuilder` produced before extraction. *(unit; existing refs tests stay green)*
- Builder filters out `possible` edges from callers and callees. *(unit)*
- 25 certain callees → `edges.length === 20`, `overflow === 5`; sorted by file then symbol start line. *(unit)*
- Exactly 20 edges → `overflow === 0`. *(unit)*
- Reference list → `references.total` and `references.kindCounts` match a hand-counted set. *(unit)*
- History passes through unchanged (already capped by the port). *(unit)*

**Components.**

```ts
// packages/core/src/intermediate-representation/reference-kinds.ts
export function countReferenceKinds(
  references: readonly SymbolReference[],
): Readonly<Record<ReferenceKind, number>>;
```

```ts
// packages/core/src/intermediate-representation/context-result.ts
export const DEFAULT_CONTEXT_CAP = 20;

export interface CappedCallEdges {
  readonly edges: readonly CallEdge[]; // certain only, sorted, <= cap
  readonly overflow: number;           // certain edges beyond the cap
}

export interface ContextReferenceSummary {
  readonly total: number;
  readonly kindCounts: Readonly<Record<ReferenceKind, number>>;
}

export interface ContextResult {
  readonly identity: SymbolIdentity;
  readonly target: SymbolDecl;                 // header File/Lines + history range
  readonly definitions: readonly SymbolDecl[]; // Definition section (overloads/decls)
  readonly callers: CappedCallEdges;
  readonly callees: CappedCallEdges;
  readonly references: ContextReferenceSummary;
  readonly history: readonly HistoryEntry[];
}
```

```ts
// packages/core/src/intermediate-representation/context-result-builder.ts
export interface BuildContextResultArgs {
  readonly identity: SymbolIdentity;
  readonly target: SymbolDecl;
  readonly definitions: readonly SymbolDecl[];
  readonly callers: readonly CallEdge[];      // raw (all confidences)
  readonly callees: readonly CallEdge[];
  readonly references: readonly SymbolReference[];
  readonly history: readonly HistoryEntry[];
  readonly cap: number;
}

export class ContextResultBuilder {
  constructor(args: BuildContextResultArgs);
  build(): ContextResult;
}
```

Algorithm (prose): for each direction, drop `possible` edges, sort by file then `symbol.range.startLine`, take the first `cap` as `edges`, set `overflow` to the remaining certain count. Reference summary via `countReferenceKinds`. History passed through.

**Commit plan.**
1. `test: count reference kinds via shared helper` — unit for `countReferenceKinds`; red. *(tests first; refactor prep)*
2. `refactor(core): extract countReferenceKinds from RefsResultBuilder` — move the logic out, `RefsResultBuilder` delegates, export the function. *(pure refactor, no behavior change)*
3. `test: build context result with cap, overflow, and summary` — unit for `ContextResultBuilder`; red. *(tests first)*
4. `feat(core): add ContextResult model` — `context-result.ts` types + cap constant + index exports, no callers. *(type-only)*
5. `feat(core): add ContextResultBuilder` — builder implementation. *(first use of the model)*

**Done when.** Builder unit tests green; refs tests unaffected by the extraction; cap/overflow/sort/summary all asserted. `ContextResult` exported. CI green.

---

## Phase 6 — `context` renderer

**Behavior delivered.** `@symnav/renderer` turns a `ContextResult` into the spec's text block and a JSON variant. Empty sections render with `(none)`; multi-site edges show `[call ×N]`; overflow lines point at `graph`.

**Test cases.**
- Full result → header (`Context`/`File`/`Lines`), `Definition` with `[implementation]` tag, `Callers` (call-site preview), `Callees` (signature preview), `References` (`Total`/`Kinds`/`Run`), `Recent History` numbered entries — matches a spec-shaped snapshot. *(unit)*
- Caller with three sites → `[call ×3]`, preview is the first site's line. *(unit)*
- Callees over cap → `… N more callees. Run: symnav graph <id> --outgoing`; callers symmetric with `--incoming`. *(unit)*
- Every empty section → header + `(none)` (callers, callees, references with zero total, history). *(unit)*
- Multi-file callers collapse single-child directories like `refs`. *(unit)*
- `renderContextJson` is `JSON.stringify(result) + "\n"`, certain edges only (mirrors text). *(unit)*

**Components.**

```ts
// packages/renderer/src/context/render-context-text.ts
export function renderContextText(result: ContextResult): string;

// packages/renderer/src/context/render-context-json.ts
export function renderContextJson(result: ContextResult): string;
```

Reuses `formatRange`, `formatHeadLine`, `formatIdentityPath`, `treeGlyphsFor`, `bracketTagFor`, and `formatSymbolIdentity` (for the `Run:` line). A context-local call-edge tree builder groups edges by file with single-child collapsing (own builder, not the `SymbolReference`-typed `reference-tree.ts`); leaf entries render symbol-style (`range: path  [call ×N]` + one preview line) — call-site line for callers, signature for callees.

**Commit plan.**
1. `test: render context sections, caps, empties, multi-site` — renderer unit tests against constructed `ContextResult`; red. *(tests first)*
2. `feat(renderer): add context call-edge tree builder` — the file-grouping/collapsing helper alone. *(new code, no callers)*
3. `feat(renderer): add context text and json renderers` — `renderContextText`/`renderContextJson` + index exports. *(uses the helper)*

**Done when.** Renderer unit snapshots match the spec block; caps, overflow targets, `[call ×N]`, and all empty sections asserted. CI green.

---

## Phase 7 — `context` command, CLI wiring, e2e

**Behavior delivered.** `symnav context <symbol-id>` and `--json` work end to end against real fixtures. Ambiguous (multi-impl) and missing symbols fail with `Cannot answer: …`. Telemetry records one event. README + SKILL.md document the workspace-only / certain-only scope.

**Test cases.**
- `context` against a symbol with callers, callees, references, and committed history → byte-for-byte spec-shaped snapshot. *(e2e; fixture `context-cases` with `dot-git/`)*
- Symbol with > 20 callers → overflow line pointing at `graph --incoming`. *(e2e)*
- Isolated leaf symbol (no callers, no callees) → both sections `(none)`. *(e2e)*
- Symbol in an uncommitted file → `Recent History` `(none)`. *(e2e)*
- `--json` → parseable, certain edges only, sections present. *(e2e)*
- Missing symbol id → `Cannot answer: no symbol … found`, exit 1. *(e2e)*
- Interface method with multiple implementations → `Cannot answer:` ambiguity message listing candidate ids, exit 1. *(e2e)*
- Telemetry: with telemetry enabled, one event with `command: "context"` and `resultCounts` keys `callers`/`callees`/`references`/`history`; `SYMNAV_TELEMETRY=0` writes nothing; output identical either way. *(e2e)*

**Components.**

```ts
// packages/core/src/backend/errors.ts (addition)
export class AmbiguousSymbolError extends UserFacingError {
  constructor(identity: SymbolIdentity, candidates: readonly SymbolDecl[]);
  get reason(): string; // "symbol <id> matches multiple implementations: <id>, <id> — query one directly"
}
```

```ts
// apps/cli/src/commands/context/context-command.ts
export interface ContextArgs {
  readonly symbolId: string;
}
export const contextCommand: Command<ContextResult, ContextArgs>;

// apps/cli/src/commands/context/register-context-command.ts
export function registerContextCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void;
```

`compute` (prose): `parseSymbolIdentity`; `workspace.resolveInputPath`; `enumerate`; `router.findOrThrow`; filter accepted files. `findCallTarget` → `not-found` throws `SymbolNotFoundError`, `ambiguous` throws `AmbiguousSymbolError`, `resolved` gives `target`. Then `findDefinitions` (Definition section), `findCallers`, `findCallees`, `findReferences`, and `git.recentHistory({ workspaceRoot: workspace.root, file: target.identity.file, range: target.range, limit: 5 })`. Assemble via `ContextResultBuilder` with `cap = DEFAULT_CONTEXT_CAP`. `countResults` → `{ callers, callees, references, history }`. `describeArgs` → `classifyArgKind`/`lengthBucketOf` of `symbolId`, `flags: []`.

**Commit plan.**
1. `test: context command end to end across fixtures` — e2e specs + `context-cases` fixture with `dot-git/`; red. *(tests first)*
2. `feat(core): add AmbiguousSymbolError` — error type + index export, no throwers. *(type-only)*
3. `feat(cli): add context command` — `context-command.ts` (compute + renderers wired + telemetry hooks). *(new behavior)*
4. `feat(cli): register context command` — `register-context-command.ts` + `program.ts` wiring. *(wiring only)*
5. `docs: document context scope` — README + `symnav` SKILL.md note that `context` is workspace-only and certain-edges-only, pointing at `graph` for possible/dynamic edges. *(docs only)*

**Done when.** All e2e snapshots green; ambiguity and missing paths emit `Cannot answer:` with exit 1; telemetry event shape correct and `SYMNAV_TELEMETRY=0` inert; output identical with telemetry on/off. README + SKILL.md updated. Full CI-parity sequence green.

---

## Out of scope

- **Multi-hop traversal, path pagination, depth caps, possible-edge rendering** — Stage 5 (`graph`). `findCallers`/`findCallees` already carry `confidence`/`reason` for it to consume.
- **`stats` filter flags, telemetry transport/upload** — Stage 3.5 boundary; unchanged here.
- **Full ambiguity candidate tree** (spec's `Ambiguous symbol` block). `context` refuses multi-impl targets with a one-line `Cannot answer:` message; rich candidate rendering is not built.
- **De-duplicating the four backend passes** (`findCallTarget`, `findCallers`, `findCallees`, `findReferences` each build a ts-morph `Project`). Acceptable under the cold-per-invocation model; a shared-project optimization is future work alongside the daemon.
- **`--full-lines` / pagination flags on `context`** — fixed 20-edge cap, no paging; paging is `graph`'s surface.
