# Stage 5 — `graph` — Phased Plan

`symnav graph <symbol-id>`: multi-hop call-relationship graph around a symbol — incoming and outgoing sections, depth-bounded, path-paginated, possible edges inline-labeled.

Source: [`plans/000/symnav-stages.md`](../symnav-stages.md) Stage 5. Behavior contract: [`plans/000/symnav-functional-spec.md`](../symnav-functional-spec.md) `graph` section. Drill-down decisions (2026-07-04/05) baked in below.

## Goal

After all phases, `symnav graph <symbol-id>` traverses calls up to `--depth` hops (default 1, max 5) in either or both directions (`--incoming`, `--outgoing`, default both) and prints two tree sections with the root at top. A path is a maximal root-to-terminal chain (terminal = no further edges, depth cap, or cycle repeat, marked `[cycle]`). Traversal continues through possible edges; they render `[possible: <reason>]`. Pagination is path-based: single-direction runs get the full page size (default 100), both-direction runs split it (ceil/floor) across directions. Same query/state/depth/page yields byte-identical output. Depth past 5 refuses with the spec's exact multi-line message. `--json` emits the structured result. Prior commands' output is unchanged.

## Context

**Decided in drill-down.** Path = root-to-terminal chain, sorted shorter-first then by canonical-ID sequence. Traversal lives in `@symnav/core` (language-agnostic, over `LanguageBackend` one-hop calls). Both-direction pagination: page N = incoming paths at that window plus outgoing paths at that window; page count = max of the two directions'. Possible edges expand at deeper hops. Cycle closing node is shown, marked, consumes a depth hop, counts in path length. No backend memoization this stage. Repeat note computed over the displayed page.

**One-hop primitives.** `LanguageBackend` (`packages/core/src/backend/language-backend.ts`) already exposes `findCallers`/`findCallees` returning `CallEdge { symbol, sites, confidence: "certain"|"possible", reason? }` and `findCallTarget` returning `CallTargetResolution`. No backend-typescript changes needed.

**Command pipeline.** `apps/cli/src/command.ts` — `Command<Result, Args>` + `runCommand`; `handleError` writes `Cannot answer: ${reason}.\n` for `UserFacingError`, exit 1. Registration mirrors `apps/cli/src/commands/refs/register-refs-command.ts`; wiring in `apps/cli/src/program.ts`. `context-command.ts` holds a private `resolveTarget` helper (findCallTarget → `SymbolNotFoundError`/`AmbiguousSymbolError`) that `graph` reuses.

**IR + pagination.** `ContextResult`/`ContextResultBuilder` are the result-model pattern to mirror. `Paginator` + `PageRequest` + `DEFAULT_PAGE_SIZE` (100) + `InvalidPageRequestError`/`PageOutOfRangeError` in `packages/core/src/pagination/`. `formatSymbolIdentity` (`canonical-identity.ts`) is the canonical-ID string for ordering.

**Renderer.** `packages/renderer/src/context/render-context-text.ts` + `shared/render-format.ts` (`formatRange`, `formatIdentityPath`, `treeGlyphsFor`) show the section/tree conventions. Graph nests differently from context's directory trie: per the spec example, each hop renders as a full file-path line, then the node line, then its children.

**Tests.** Vitest; unit colocated; core traversal unit-testable with a fake `LanguageBackend` beside the test (mock helpers stay local, not in `@symnav/testing`). E2e under `apps/cli/test/e2e/graph/` spawning the built binary against a new `graph-cases` fixture. Workspace root detection requires a `.git` directory (`workspace/paths/find-root.ts`), so the fixture needs `dot-git/` + `ensureFixtureGitMarker` even though `graph` never reads git history.

---

## Phase 1 — Path model and traverser (core)

**Behavior delivered.** Core can turn a root symbol plus a backend's one-hop functions into the sorted list of graph paths for a direction: multi-hop, depth-bounded, cycle-terminated, possible-edge-expanding, deterministic order. No CLI surface yet.

**Test cases.** All unit, `packages/core/src/graph/graph-traverser.test.ts`, against a fake `LanguageBackend` defined beside the test (only `findCallers`/`findCallees` matter; other methods throw).

- Depth 1, root with two callees in different files → two paths of one step each, ordered by canonical ID. Asserts step `symbol`, `confidence`, `closesCycle: false`.
- Chain `a→b→c→d`, depth 3, outgoing → one path `[b, c, d]`.
- Same chain, depth 2 → one path `[b, c]`; no cycle marker on the truncated tail.
- Cycle `a→b→a`, depth 5 → one path `[b, a]` with the final step `closesCycle: true`; nothing expanded past it.
- Self-recursion `a→a` → one path `[a(closesCycle)]`.
- Diamond (`a→b→d`, `a→c→d`) → two paths both containing `d`; repeats across paths preserved.
- Possible edge at hop 1 whose target has a callee → two-step path exists; step 1 carries `confidence: "possible"` and the reason; step 2 is `certain`.
- One-hop result containing both a certain and a possible edge to the same target → single branch, certain wins.
- Ordering: mixed lengths → all shorter paths precede longer; equal length ties → element-wise `formatSymbolIdentity` comparison.
- Incoming direction uses `findCallers` and produces caller chains (mirror of the depth-1 case).

**Components.**

```ts
// packages/core/src/graph/graph-path.ts
export interface GraphPathStep {
  readonly symbol: SymbolDecl;
  readonly confidence: EdgeConfidence;
  readonly reason?: string; // set when confidence === "possible"
  readonly closesCycle: boolean;
}

export interface GraphPath {
  readonly steps: readonly GraphPathStep[]; // hop 1..n; root excluded; length >= 1
}

export const DEFAULT_GRAPH_DEPTH = 1;
export const MAX_GRAPH_DEPTH = 5;
```

```ts
// packages/core/src/graph/graph-traverser.ts
export interface GraphTraverserArgs {
  readonly backend: LanguageBackend;
  readonly files: readonly ResolvedPath[];
  readonly root: SymbolDecl;
  readonly depth: number; // 1..MAX_GRAPH_DEPTH, validated upstream
}

export class GraphTraverser {
  constructor(args: GraphTraverserArgs);
  traverseIncoming(): Promise<readonly GraphPath[]>; // sorted
  traverseOutgoing(): Promise<readonly GraphPath[]>; // sorted
}
```

Algorithm (prose): depth-first extension from the root. At each node, fetch one-hop edges for the step's direction; memoize one-hop results per `formatSymbolIdentity` key for the run so shared nodes don't re-query. Collapse duplicate targets preferring certain over possible. A chain extends until: no edges (emit path), depth reached (emit path), or the next symbol's identity already occurs in the chain or is the root (append that step with `closesCycle: true`, emit path). Sort emitted paths by length, then element-wise canonical-ID sequence.

**Commit plan.**

1. `test(core): graph traverser paths, cycles, ordering` — unit tests + local fake backend; red. *(tests first)*
2. `feat(core): add GraphPath model and depth constants` — `graph-path.ts` + index export, no callers. *(type-only, no callsites yet)*
3. `feat(core): add GraphTraverser` — traverser implementation + index export; tests green. *(one logical capability)*

**Done when.** All traverser tests green. `GraphPath`, `GraphPathStep`, `GraphTraverser`, `DEFAULT_GRAPH_DEPTH`, `MAX_GRAPH_DEPTH` exported from `@symnav/core`. CI green.

---

## Phase 2 — GraphResult and builder with split pagination (core)

**Behavior delivered.** Core can assemble sorted path lists into a paginated `GraphResult`: full page budget for a single direction, ceil/floor split for both, page count = max across directions, repeat count computed over the displayed page. Existing `Paginator` behavior unchanged.

**Test cases.** Unit, colocated in `packages/core/src/intermediate-representation/` and `packages/core/src/pagination/`.

- `validatePageRequest` extraction: existing `paginator.test.ts` stays green; direct tests for the extracted function mirror `Paginator`'s current rejections (`--all` + explicit page, non-positive page, non-positive page size).
- Both directions, 3 incoming + 3 outgoing paths, `pageSize 4` → page 1 holds first 2 incoming (ceil) + first 2 outgoing (floor); `totalPathCount` 3 each; `pageCount 2`.
- Odd split: `pageSize 5`, both → 3 incoming + 2 outgoing per page.
- Single direction (`incoming`), 5 paths, `pageSize 4` → page 1 has 4 paths, `pageCount 2`; `outgoing` absent from the result.
- Uneven directions: 10 incoming, 1 outgoing, `pageSize 4`, both → `pageCount 5` (max of ceil(10/2), ceil(1/2)); page 3 has incoming paths 5-6 and an empty outgoing page.
- `all: true` → every path in both directions, `page 1/1`.
- `page` beyond `pageCount` → `PageOutOfRangeError`.
- No paths at all → empty pages, `pageCount 1`.
- `repeatedSymbolCount`: diamond paths on one page → counts the shared symbol once; a symbol repeated only across *different* pages → not counted; root never counted.

**Components.**

```ts
// packages/core/src/pagination/validate-page-request.ts
export function validatePageRequest(request: PageRequest): void;
```

```ts
// packages/core/src/intermediate-representation/graph-result.ts
export type GraphDirection = "incoming" | "outgoing" | "both";

export interface GraphDirectionPage {
  readonly paths: readonly GraphPath[];
  readonly totalPathCount: number;
}

export interface GraphResult {
  readonly identity: SymbolIdentity;
  readonly root: SymbolDecl;
  readonly depth: number;
  readonly direction: GraphDirection;
  readonly incoming?: GraphDirectionPage; // present iff direction includes incoming
  readonly outgoing?: GraphDirectionPage;
  readonly page: number;
  readonly pageCount: number;
  readonly repeatedSymbolCount: number; // distinct non-root symbols in >1 displayed path
}
```

```ts
// packages/core/src/intermediate-representation/graph-result-builder.ts
export interface BuildGraphResultArgs {
  readonly identity: SymbolIdentity;
  readonly root: SymbolDecl;
  readonly depth: number;
  readonly direction: GraphDirection;
  readonly incomingPaths: readonly GraphPath[]; // pre-sorted by traverser
  readonly outgoingPaths: readonly GraphPath[];
  readonly pageRequest: PageRequest;
}

export class GraphResultBuilder {
  constructor(args: BuildGraphResultArgs);
  build(): GraphResult;
}
```

Budget rule (prose): effective page size = `pageSize ?? DEFAULT_PAGE_SIZE`. Single direction → whole budget. Both → incoming gets ceil(half), outgoing floor(half). Each included direction slices its own list at `(page-1)*budget`; `pageCount = max(1, ...per-direction ceil(total/budget))`. Builder reuses `validatePageRequest` and `PageOutOfRangeError` rather than `Paginator` (Paginator throws when one direction exhausts before the other, which is legal here).

**Commit plan.**

1. `refactor(core): extract validatePageRequest from Paginator` — pure extraction, `Paginator` delegates; no behavior change. *(refactor only, before new functionality)*
2. `test(core): graph result builder split pagination` — builder + validation tests; red. *(tests first)*
3. `feat(core): add GraphResult model` — `graph-result.ts` + index export, no callers. *(type-only, no callsites yet)*
4. `feat(core): add GraphResultBuilder` — builder + index export; tests green. *(one logical capability)*

**Done when.** Builder and validation tests green; `paginator.test.ts` untouched and green. CI green.

---

## Phase 3 — Self-rendering errors and graph request errors (core + cli)

**Behavior delivered.** A `UserFacingError` can own its full stderr rendering. The depth-cap refusal prints the spec's exact multi-line text; conflicting direction flags and malformed depth values fail as user errors. Every existing error's output is byte-identical to before.

**Test cases.**

- `UserFacingError.render()` default returns `Cannot answer: ${reason}.\n` — unit, `packages/core/src/errors.test.ts` (new file colocated with `errors.ts`).
- `GraphDepthExceededError(12).render()` returns the spec text verbatim (`Cannot run graph with depth 12.\nMaximum supported depth is 5.\n\nTo continue exploration:\n1. Run with depth 5.\n2. Pick a leaf symbol from the output.\n3. Run graph again from that symbol.\n`) — unit, `packages/core/src/graph/errors.test.ts`.
- `InvalidGraphRequestError` reason carries the explanation — unit, same file.
- Existing e2e error snapshots (workspace, refs, context suites) unchanged — regression via existing suites.

**Components.**

```ts
// packages/core/src/errors.ts (addition)
export abstract class UserFacingError extends Error {
  abstract get reason(): string;
  render(): string; // default: `Cannot answer: ${this.reason}.\n`
}
```

```ts
// packages/core/src/graph/errors.ts
export class GraphDepthExceededError extends UserFacingError {
  constructor(requestedDepth: number);
  get reason(): string;
  override render(): string; // spec refusal text, verbatim
}

export class InvalidGraphRequestError extends UserFacingError {
  constructor(explanation: string);
  get reason(): string;
}
```

`handleError` in `apps/cli/src/command.ts` switches from formatting `Cannot answer: ${err.reason}.` itself to writing `err.render()`; exit codes unchanged.

**Commit plan.**

1. `test(core): UserFacingError default render` — red (method absent). *(tests first)*
2. `refactor(core): move user-error formatting into UserFacingError.render` — add default `render()`, `handleError` delegates to it; no output change anywhere. *(refactor only, no behavior change)*
3. `test(core): graph depth refusal and request errors` — red. *(tests first)*
4. `feat(core): add graph request errors` — `graph/errors.ts` + index exports; tests green. *(one logical addition)*

**Done when.** New error tests green; full existing e2e suite green with unchanged snapshots. CI green.

---

## Phase 4 — Graph renderer (text and JSON)

**Behavior delivered.** `@symnav/renderer` turns a `GraphResult` into the spec's text layout — header, Incoming/Outgoing sections with root at top, file-then-node nesting, `[caller]`/`[callee]`/`[possible: …]`/`[cycle]` labels, no preview lines — and into JSON.

**Test cases.** Unit, colocated in `packages/renderer/src/graph/`.

- Tree merge: two paths sharing a first step merge into one child with two grandchildren; step order follows first occurrence in the sorted path list.
- Cycle steps never receive children.
- Full text render of a both-direction result reproducing the spec's depth-2 example shape: header (`Graph:`/`File:`/`Lines:`/`Depth:`/`Direction:`/`Edges: calls`), each hop as file-path line then `<range>: <identity-path>  [<tag>]` then signature lines, glyph indentation matching.
- Direction tags: incoming steps tagged `[caller]`, outgoing `[callee]`; possible steps tagged `[possible: <reason>]` instead; cycle steps get `  [cycle]` appended after their tag.
- Consecutive same-file siblings share one file-path line.
- Empty included direction → section header + root-only tree (file, node line, signature).
- Single-direction result renders only its section.
- `Page: n/m` line appears after `Edges:` only when `pageCount > 1` (keeps spec examples byte-reproducible).
- Repeat note: `repeatedSymbolCount 3` → trailing `Note: 3 symbols appear in multiple paths.`; count 1 → singular phrasing; count 0 → no note.
- JSON: parse of `renderGraphJson` output round-trips `identity`, per-direction `paths`, `page`, `pageCount`, `repeatedSymbolCount`.

**Components.**

```ts
// packages/renderer/src/graph/graph-path-tree.ts
export interface GraphPathTreeNode {
  readonly step: GraphPathStep;
  readonly children: readonly GraphPathTreeNode[];
}

export function buildGraphPathTree(paths: readonly GraphPath[]): readonly GraphPathTreeNode[];
```

```ts
// packages/renderer/src/graph/render-graph-text.ts
export function renderGraphText(result: GraphResult): string;
```

```ts
// packages/renderer/src/graph/render-graph-json.ts
export function renderGraphJson(result: GraphResult): string;
```

Merging (prose): children merge on step symbol identity + confidence; a merged node's children are the union of its paths' continuations, first-occurrence ordered. Rendering walks the merged tree grouping each node's children by file so a file-path line precedes its nodes, following the spec example's indentation.

**Commit plan.**

1. `test(renderer): graph tree merge and text layout` — red. *(tests first)*
2. `feat(renderer): add graph path tree` — `graph-path-tree.ts` + export; merge tests green. *(one unit; no text rendering yet)*
3. `feat(renderer): add graph text and JSON renderers` — both `render-graph-*.ts` + index exports; all renderer tests green. *(one logical surface)*

**Done when.** Renderer tests green, including a byte-exact reproduction of the spec's depth-2 example layout from a hand-built `GraphResult`. CI green.

---

## Phase 5 — `graph` command, fixture, e2e, docs

**Behavior delivered.** `symnav graph <symbol-id>` works end-to-end with `--incoming`, `--outgoing`, `--depth`, `--page`, `--page-size`, `--all`, `--json`; refuses depth > 5 with the spec text; rejects conflicting direction flags and malformed depth; telemetry records shape-only events like every other command.

**Test cases.** E2e in `apps/cli/test/e2e/graph/graph.test.ts` against new fixture `packages/testing/fixtures/graph-cases/` (snapshot files under `__snapshots__/`), plus the descriptor unit test.

- Fixture work: `graph-cases` with `dot-git/` (workspace marker; no commit history needed), `package.json`, and `src/` containing: a five-deep chain, a hub with three callers and three callees (fan-in/fan-out), a three-symbol cycle, a dynamic-dispatch table producing possible edges whose targets have further callees, and an isolated leaf.
- Default run on the hub → both sections, depth 1, snapshot.
- `--incoming` / `--outgoing` on the hub → single section each, snapshot.
- `--depth 3` on the chain → multi-hop nesting, snapshot.
- `--depth 5` on the chain → deepest path truncated at 5 steps without a cycle marker.
- Cycle symbol → `[cycle]` marker present, no expansion past it, snapshot.
- Dynamic dispatch → `[possible: …]` label at the uncertain hop and certain hops beyond it, snapshot.
- Isolated leaf → both sections render root-only trees.
- `--depth 12` → stderr equals the spec refusal verbatim, exit 1, empty stdout.
- `--depth 0` and `--depth x` → `Cannot answer:` user error, exit 1.
- `--incoming --outgoing` together → user error naming the conflict, exit 1.
- Pagination: `--page-size 2` on the fan-out → page 1 and page 2 differ, `Page:` line present; running page 1 twice → byte-identical stdout (determinism).
- `--json` on the hub → parsed result has both directions, correct `totalPathCount`s.
- Ambiguous target and unknown symbol → existing `AmbiguousSymbolError`/`SymbolNotFoundError` messages (reused path, snapshot).
- Descriptor: add `graph` to `apps/cli/src/commands/command-descriptor.test.ts` — flags sorted, counts `{incomingPaths, outgoingPaths, pages}`.

**Components.**

```ts
// apps/cli/src/commands/resolve-call-target.ts (moved from context-command.ts, unchanged)
export async function resolveCallTarget(
  backend: LanguageBackend,
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<SymbolDecl>;
```

```ts
// apps/cli/src/commands/graph/graph-command.ts
export interface GraphArgs {
  readonly symbolId: string;
  readonly incoming: boolean;
  readonly outgoing: boolean;
  readonly depth: number | undefined;
  readonly page: number | undefined;
  readonly pageSize: number | undefined;
  readonly all: boolean;
}

export const graphCommand: Command<GraphResult, GraphArgs>;
```

```ts
// apps/cli/src/commands/graph/register-graph-command.ts
export function registerGraphCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void;
```

`compute` (prose): parse identity → resolve input path → enumerate → route backend → filter accepted → validate args (both direction flags → `InvalidGraphRequestError`; depth not a positive integer → `InvalidGraphRequestError`; depth > `MAX_GRAPH_DEPTH` → `GraphDepthExceededError`) → `resolveCallTarget` → `GraphTraverser` for each included direction (skipped direction contributes `[]`) → `GraphResultBuilder`. Flags for telemetry mirror `refsFlags` (`all`, `depth`, `incoming`, `outgoing`, `page`, `page-size`, sorted).

Docs: `.claude/skills/symnav/SKILL.md` gains a `graph` row and drops the "reach for `graph` when it lands" caveat.

**Commit plan.**

1. `refactor(cli): move resolveTarget into shared resolve-call-target` — pure move out of `context-command.ts`, import updated; no behavior change. *(pure move, no edits)*
2. `test(e2e): graph command against graph-cases fixture` — fixture + e2e specs + descriptor entry; red. *(tests first)*
3. `feat(cli): add graph command` — `graph-command.ts` + `register-graph-command.ts` + `program.ts` wiring; e2e green. *(one logical capability)*
4. `docs: cover graph in symnav skill` — skill doc update only. *(docs only)*

**Done when.** Full e2e suite green including determinism and refusal cases. `pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint && pnpm typecheck` clean. Spec's `graph` output examples reproducible from the fixture (modulo fixture symbol names; the possible-edge reason renders the backend's actual reason string, not the spec illustration's).

---

## Out of scope

- Backend one-hop memoization across calls (deferred until measurably slow; traverser memoizes within a single run only).
- Lazy/streaming path enumeration — traversal fully materializes before pagination.
- Edge kinds beyond calls, graph presets, `impact`/`history`/`diff`/`impls`/`search-text` — spec's V1 excludes; Beyond-V1 section of the stages doc.
- Error-voice review across commands and packaging — Stage 6.
- Renaming the backend's dynamic-dispatch reason string to match the spec example's wording — Stage 6 error/message review if desired.
