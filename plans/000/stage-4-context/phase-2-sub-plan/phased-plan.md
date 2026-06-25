# Preserve Dynamic Callee Candidates

One-phase sub-plan for tightening Stage 4 Phase 2 after PR #65 feedback on type-only dynamic callee edges.

## Goal

`findCallees` keeps `CallEdge.symbol` runtime-only while preserving concrete dynamic dispatch candidates when they are cheaply enumerable. Dynamic calls through local object, array, and conditional expressions produce `possible` edges to real callable symbols. Dynamic calls with no concrete candidates are ignored.

## Context

Stage 4 Phase 2 introduced `CallEdge` in `packages/core/src/intermediate-representation/call-edge.ts` and `LanguageBackend.findCallees` in `packages/core/src/backend/language-backend.ts`. `packages/backend-typescript/src/call-graph/find-callees.ts` currently returns `readonly CallEdge[]`. PR feedback commit `67ee8ca` stopped reporting type aliases as dynamic callees, but also drops useful concrete candidates for dynamic table dispatch. Existing backend integration coverage lives in `packages/backend-typescript/test/integration/find-callees.test.ts`.

## Phase 1 — Dynamic Callee Candidates

**Behavior delivered.** `findCallees` still returns `readonly CallEdge[]`. A `CallEdge` never points at a type-only symbol. Dynamic dispatch through enumerable object/array/conditional candidates returns concrete `possible` edges. Dynamic dispatch through type-only callable shapes with no reachable concrete candidates returns no edge.

**Test cases.**

- `Record<string, Action>` table initialized with `{ a: helperA, b: helperB }` and called through `table[key]()` returns possible edges to `helperA` and `helperB`, not to `Action`. *(integration; extend `packages/backend-typescript/test/integration/find-callees.test.ts`)*
- Interface-typed table initialized with callable values returns possible edges to the callable initializer values. *(integration)*
- Concrete object table called with key type `"a" | "b"` returns possible edges to only `helperA` and `helperB`. *(integration)*
- Concrete object table called with literal key `"a"` remains a single `certain` edge to `helperA`. *(integration; existing test stays green)*
- Array table initialized with `[helperA, helperB]` and called through `array[index]()` returns possible edges to both callable elements. *(integration)*
- Conditional callee `(flag ? helperA : helperB)()` returns possible edges to both branch callables. *(integration)*
- Table with no enumerable local candidates and callable target shape returns no edge. *(integration)*

**Components.**

```ts
// packages/core/src/intermediate-representation/call-edge.ts
export type EdgeConfidence = "certain" | "possible";

export type CallSite = SourceMatch;

export interface CallEdge {
  readonly symbol: SymbolDecl;
  readonly sites: readonly CallSite[];
  readonly confidence: EdgeConfidence;
  readonly reason?: string;
}
```

```ts
// packages/core/src/backend/language-backend.ts
findCallees(
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly CallEdge[]>;
```

```ts
// packages/backend-typescript/src/call-graph/find-callees.ts
export async function findCallees(args: FindCalleesArgs): Promise<readonly CallEdge[]>;
```

Algorithm notes: outgoing dynamic candidate discovery stays local and cheap. It may inspect literal object and array initializers, one-hop `const` aliases, workspace imports that resolve to `const` literal initializers, conditional expressions, and statically knowable key literals/unions. It does not follow mutations, parameters, return values, broad dataflow, or workspace-wide caller scans. If no concrete callable candidate is reachable, the call produces no edge.

**Commit plan.**

1. `test: cover dynamic callee candidate shapes` — Adds failing backend integration tests for object maps, interface maps, union keys, arrays, conditionals, and ignored type-shaped dispatch. *(tests first)*
2. `feat(backend-typescript): preserve dynamic callee candidates` — Implements candidate enumeration for `findCallees` without changing the core backend contract. *(behavior change only after tests are in place)*

**Done when.** Backend integration tests prove type aliases are never emitted as callees, enumerable dynamic dispatch emits concrete possible edges, ignored dynamic dispatch with no candidates emits no edge, and literal-key dispatch still emits a certain edge. `pnpm --filter @symnav/backend-typescript test -- find-callees.test.ts`, `pnpm --filter @symnav/backend-typescript typecheck`, and `pnpm --filter @symnav/backend-typescript lint` pass.

## Out of scope

- Changing the `LanguageBackend.findCallees` return type.
- Changing the `LanguageBackend.findCallees` return type.
- Rendering possible edges in `context`; Stage 4 keeps context certain-only.
- Implementing `graph`; Stage 5 owns user-facing possible-edge rendering and traversal.
- Workspace-wide dynamic caller scans; `findCallers` remains reference-based.
- Mutation tracking, multi-hop alias chasing, return-value analysis, parameter analysis, and general dataflow.
- Documentation updates; this remains internal until graph exposes possible edges.
