# Symnav Implementation Stages

This document is the implementation roadmap. It defines **what** we build, **why**, and **in what order** — at the level a product or architecture review needs. It deliberately contains no code, no types, and no interface signatures; those live in the implementation itself and in per-stage planning notes.

The functional contract (what the product *does*) is in [`symnav-functional-spec.md`](./symnav-functional-spec.md). This document is about the *journey* to that contract.

---

## Guiding Principles

These principles override convenience at every stage. When a stage's scope and a principle conflict, the principle wins and the scope shrinks.

- **TDD throughout.** Every behavior is specified by a failing test before it has an implementation. This applies to unit, integration, and end-to-end tests alike.
- **Loose coupling.** Modules depend on the smallest possible surface of their collaborators. Package boundaries enforce this physically; folder conventions do not.
- **High cohesion.** Each module and package has a single, articulable reason to exist. If you cannot describe a module's purpose in one sentence, it is doing too much.
- **Separation of concerns.** Computing *what* to show, *how* to show it, and *how to talk to a language toolchain* are three different concerns and live in three different packages.
- **Abstraction.** Cross-package contracts are stated in terms of intent (what is asked), not mechanism (how it is computed).
- **Iterate vertically.** Every stage produces a working, releasable slice through the full architecture. No stage produces only scaffolding for a later stage.

---

## Architectural Recap

The architecture is locked. Stages are framed against it.

- **Repo:** pnpm workspace.
- **Deployable unit:** `apps/cli` — the `symnav` binary, published to npm. Pure composition; no business logic.
- **Library packages:**
  - `packages/core` — command logic, the in-memory result model (IR), workspace services, the language-backend interface. Owns the contracts other packages depend on. Depends on nothing internal.
  - `packages/renderer` — turns the IR into human-readable output (Unicode tree) and structured output (JSON). Depends only on `core`'s IR.
  - `packages/backend-typescript` — the TypeScript implementation of the language-backend interface. The only package that knows about ts-morph, tsserver, or anything TypeScript-toolchain-specific.
- **Process model:** cold per invocation in v1. A daemon is a future wrapper, not a rewrite — command logic stays a pure function of (workspace, args).
- **Configuration:** none. Conventions and CLI flags only. `.gitignore` is honored as the workspace-ignore source of truth.

---

## Stage 0 — Project Foundations

**What we deliver.** A working monorepo with all four packages scaffolded, a test runner wired across them, lint/format/typecheck green on an empty repo, and a working CI signal. No command logic. No CLI behavior beyond a `symnav --version` smoke check.

**Why this stage.** TDD requires the test harness to be the very first thing that exists. Lint rules enforcing the dependency direction (`renderer` cannot import `backend-typescript`, etc.) need to be in place before any code is written, otherwise violations accumulate and the principle becomes aspirational. Every later stage assumes a green pipeline; that assumption has to be true at stage 1, not stage 3.

**In scope.**
- pnpm workspace, four packages with the locked dependency direction.
- Test runner shared across packages with a documented convention for unit, integration, and end-to-end tests.
- A fixture-project convention under a top-level fixtures location, with one trivial fixture used as a smoke test.
- Lint rules that enforce the inter-package import graph and fail CI on violation.
- A repository-level CLAUDE-style contributor guide pointing at this document.
- CI configuration sufficient to run lint, typecheck, and test on every push.
- The `symnav` binary exists and prints its version.

**Out of scope.** Any of the v1 commands. Any language-backend behavior beyond the existence of the interface in `core`. Publishing to npm.

**Done when.** A new contributor can clone the repo, run a single install command, and watch the test suite pass. Adding a violating import (e.g. `renderer` importing `backend-typescript`) breaks CI.

---

## Stage 1 — `overview`

**What we deliver.** A working `symnav overview <file>` command that prints the symbol structure of a single TypeScript file: hierarchy, signatures, line ranges, matching the format described in the functional spec. Honors `.gitignore`. Supports the `--json` flag. Output is deterministic and stable across runs.

**Why this stage.** `overview` is the smallest command that exercises every layer of the architecture end to end: the CLI parses a file path, the command logic asks the language backend for the file's symbols, the IR is assembled, the renderer prints it. It needs **zero cross-file resolution**, no references, no graphs, no pagination, no symbol-ID resolution beyond what a single file produces. It is the walking skeleton.

This stage's real output is not just a working `overview` — it is the IR shape, the renderer's rendering rules, the language-backend interface contract, the fixture-test rhythm, and the TDD rhythm itself. Every later stage builds on those decisions, so we let `overview` drive them.

**In scope.**
- Workspace root detection (nearest `.git` ancestor; `--cwd` override).
- Ignore-aware file access shared by `core`.
- The language-backend interface's first method: producing a file's symbol structure.
- The TypeScript backend's first implementation of that method.
- The renderer's first surface: a file overview as a Unicode tree, plus a JSON variant.
- End-to-end snapshot tests against fixture projects covering: a class with methods, top-level functions, top-level constants, nested symbols, an ignored file (rejected), an empty file.

**Out of scope.** Any command other than `overview`. Pagination. Symbol-ID resolution across files. Overload disambiguation as a first-class concept (single-file overloads can be displayed but the full canonical-ID rules are deferred to Stage 2).

**Done when.** Every output example for `overview` in the functional spec, given an equivalent fixture, is produced byte-for-byte. The same query against the same workspace produces identical output every time. CI is green.

---

## Stage 2 — `resolve` and `def`

**What we deliver.** A working `symnav resolve <name>` (with optional fuzzy matching) and `symnav def <symbol-id>`. `resolve` produces matching symbols and files in two sections; `def` produces the locations a symbol is defined, including overload signatures, declarations, and multiple implementations when the symbol is a contract or base.

**Why this stage.** These two commands together validate the **canonical symbol ID** as the project's central identifier. `resolve` is what produces canonical IDs for downstream commands; `def` is the first command to consume them. Pairing them in one stage forces the round-trip to be correct: a symbol surfaced by `resolve` must be queryable by `def` without any additional lookups.

This is also the stage where overload disambiguation becomes real. The functional spec prescribes a specific shape (e.g. an overload-1/overload-2/implementation form) and the rules for how IDs survive across edits to a file are decided here.

**In scope.**
- Symbol-name lookup, exact and fuzzy modes.
- Canonical symbol ID composition rules, including overload disambiguation, decided and locked.
- Multi-implementation discovery (interface methods, abstract methods, base classes).
- Renderer surfaces for `resolve` (two-section output) and `def` (kind-tagged definition tree).
- Fixture coverage for: ambiguous names producing the spec's stop-and-show-candidates behavior, overloaded functions, an interface with multiple concrete implementations, a name that matches symbols and files both, a name that matches nothing.

**Out of scope.** References. Callers and callees. Pagination beyond what these commands trivially require.

**Done when.** Any canonical ID surfaced by `resolve` is accepted by `def`. Ambiguity behavior matches the spec: the tool stops and shows candidates, never guesses. Overload disambiguators are stable across re-runs on the same source.

---

## Stage 3 — `refs`

**What we deliver.** A working `symnav refs <symbol-id>` that lists every reference to a symbol across the workspace, excluding the symbol's own definition and declaration. References include imports, exports, type uses, test usages, and ordinary call/access sites — none of these are filtered. Output is paginated, stable, and matches the compact filesystem-tree format from the spec.

**Why this stage.** This is the first command requiring real **cross-file** semantic work. It also forces the project to confront pagination, stable sorting, reference-kind tagging, and preview trimming — all features that show up in later stages but are easiest to design correctly in the context of a single command first.

It is also the first stage where the "no stale data" guarantee meets non-trivial computation: stale results here would silently mislead an agent. The cold-per-invocation model has to demonstrably hold up.

**In scope.**
- Cross-file reference discovery via the language backend.
- Reference-kind classification (import, export, usage, test, etc.).
- Preview rules: trimmed by default, full lines on request, matched-symbol-preserved when possible.
- Pagination with the spec-defined defaults and stable ordering rules.
- Renderer surface for `refs`, including the compact filesystem tree with single-child collapsing.
- Fixture coverage for: a symbol with references in many files, a symbol referenced only by itself (zero true refs), a symbol used through re-exports, a symbol referenced from tests, pagination across page boundaries.

**Out of scope.** Callers/callees as a *graph* concept. Recent history. The `context` composition.

**Done when.** Same query, same workspace state produces identical pages. Page two contains the same results every time. No reference kind is silently filtered. Agents can rely on `refs` as the authoritative reference enumeration for v1.

---

## Stage 4 — `context`

**What we deliver.** A working `symnav context <symbol-id>` that produces the compact context block described in the spec: definition, direct callers with previews, direct callees with previews, a reference summary (counts and a hint to run `refs`), and a recent-history summary from git. Sections with no results are still shown.

**Why this stage.** `context` is a **composition** stage. It reuses everything stages 1–3 built — definition lookup, reference enumeration, the IR — and adds two new ingredients: direct caller/callee discovery (capped by default, with overflow pointing at `graph`) and a bounded read of git history. By the time we reach this stage the underlying capabilities are already correct, so this stage is mostly about composition discipline and the new git-integration surface.

Doing `context` before `graph` is intentional. `context` only needs *direct* (one-hop) callers and callees. Building that one-hop capability inside `context` first means `graph` in stage 5 inherits a tested traversal primitive instead of inventing one.

**In scope.**
- Direct caller and callee discovery via the language backend, with the spec-defined cap and overflow message.
- Bounded git-history retrieval for a symbol's containing file or symbol range.
- Renderer surface for the multi-section `context` output, including the empty-section handling.
- Fixture coverage for: a symbol with many callers (cap exceeded, overflow message present), a symbol with no callers, a symbol in a file with rich git history, a symbol in a file with no history (e.g. uncommitted), an isolated leaf symbol.

**Out of scope.** Multi-hop traversal. Path-based pagination. Possible-edge labeling.

**Done when.** Every output example for `context` in the functional spec is reproducible from a fixture. The reference summary's counts agree with running `refs` independently against the same symbol.

---

## Stage 5 — `graph`

**What we deliver.** A working `symnav graph <symbol-id>` with the spec's defaults (depth one, both directions, calls only) and the full set of explicit flags (`--incoming`, `--outgoing`, `--depth`). Multi-hop traversal up to the maximum supported depth, with the spec's refusal-and-explain behavior past the cap. Path-based pagination with stable ordering. Possible/low-confidence edges included by default and inline-labeled.

**Why this stage last.** `graph` is the heaviest command in v1. It compounds every prior capability — symbol resolution, definition lookup, caller/callee discovery — and adds **multi-hop traversal**, **path-based pagination**, **depth limits with a refusal pathway**, and **possible-edge classification**. Building it last means the underlying primitives are battle-tested by four prior stages of fixture-driven evidence.

**In scope.**
- Multi-hop traversal in either or both directions, calls-only edges, depth-bounded.
- Depth-cap refusal with the spec's explanatory output and continuation guidance.
- Path-based pagination with the spec's stable ordering: shorter paths first, ties broken by canonical symbol ID.
- Possible-edge detection (e.g. dynamic property access) and inline labeling.
- Repeat-path tolerance (do not hide repeated symbols on different paths) and the optional repeat note.
- Renderer surface for `graph`: incoming and outgoing sections, root at top, symbol-only nodes, no preview lines.
- Fixture coverage for: a deep-but-bounded call chain, a fan-in/fan-out pattern, a cycle, dynamic dispatch producing possible edges, depth exceeding the cap.

**Out of scope.** Anything in the spec's explicit V1-excludes list (`impact`, `history`, `diff`, `impls`, `search-text`). Graph presets. Edge kinds beyond calls.

**Done when.** All `graph` output examples in the spec are reproducible from fixtures. The same query/state/depth/page produces the same paths in the same order. Depth-cap refusal triggers exactly when expected.

---

## Stage 6 — Release Hardening

**What we deliver.** v1.0 published to npm: working install via `npm install -g`, working one-shot use via `npx`, a README oriented at agents, error-message review pass, performance baseline, and a contributor guide.

**Why this stage.** v1 is not done when the commands work; it is done when an external user (human or agent) can install and use it without context from the development team. This stage is short but real — packaging, install UX, and documentation are the difference between a working repo and a usable product.

**In scope.**
- Build pipeline producing a single publishable `symnav` package with workspace dependencies bundled.
- Install-and-use smoke test on a clean machine.
- Error message review across every command for consistency with the spec's voice (e.g. the prescribed "Cannot answer:" wording).
- Performance baseline: time-to-first-result measurements on representative project sizes, recorded as a starting point for future work.
- Agent-oriented usage documentation.

**Out of scope.** Daemon mode. Additional language backends. Any command outside the v1 list.

**Done when.** A clean machine can run `npm install -g symnav` and use every v1 command against a real TypeScript project. CI publishes successfully. The README is accurate.

---

## Beyond V1

These items are explicitly **not** part of the v1 plan. They are catalogued here so we don't quietly absorb them into earlier stages.

- **Daemon / persistent process.** A future performance optimization that wraps the existing pure command logic. Worth doing once v1 is in real use and warm-cache wins are measurable.
- **Additional language backends.** Python (pyright), Go (gopls), Rust (rust-analyzer), etc. The `core` package's language-backend interface is the integration point. Adding a backend should not require touching `core`, `renderer`, or `apps/cli`.
- **Excluded commands.** `impact`, `history`, `diff`, `impls`, `search-text` are explicitly out of v1 per the functional spec.
- **Alternative renderers.** The `renderer` package's separation makes a future non-terminal consumer (IDE extension, web UI, alternative output format) a peer of the current renderer rather than a rewrite. We are not building one in v1.

---

## Stage Sequencing Summary

| Stage | Delivers | Primary new capability |
|---|---|---|
| 0 | Foundations | Working monorepo, test harness, enforced dependency direction |
| 1 | `overview` | The walking skeleton; IR + renderer + backend interface locked |
| 2 | `resolve`, `def` | Canonical symbol IDs and overload disambiguation |
| 3 | `refs` | Cross-file reference enumeration and pagination |
| 4 | `context` | Composition + direct callers/callees + git history |
| 5 | `graph` | Multi-hop traversal and path-based pagination |
| 6 | Release | Distribution, documentation, performance baseline |

Each stage is independently releasable. No stage's scope expands to anticipate a later stage's needs.
