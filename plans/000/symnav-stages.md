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

**Remarks (post-drill-down, 2026-05-03).** During Stage 0 planning the following adjustments were made to the original scope above. They refine, not replace, the text:
- **Five packages, not four.** A private `packages/testing` package (published as `@symnav/testing`, never released to npm) is added alongside `apps/cli`, `packages/core`, `packages/renderer`, and `packages/backend-typescript`. It owns the fixture loader, shared test helpers, and the fixture projects themselves. It may depend on `@symnav/core` (for IR types). It is permitted as an import only from test files in other packages; the ESLint boundary rule and TS `tsconfig.test.json`-only references enforce that.
- **Fixtures live under `packages/testing/fixtures/`,** not at a top-level fixtures directory.
- **Toolchain locked.** Node 20+, ESM-only, TypeScript built with `tsc --build` + project references (no bundler). pnpm version pinned via `packageManager`. Vitest as the test runner. ESLint flat config + `eslint-plugin-boundaries` + Prettier-via-ESLint. GitHub Actions on Linux/Node 20, single-version matrix. `commander` for CLI argument parsing. `tsx` for dev-time CLI execution.
- **Two-layer dependency-direction enforcement.** Layer 1: ESLint `boundaries` rule with a test-file exemption for `@symnav/testing`. Layer 2: TypeScript project references — `packages/renderer`'s `tsconfig.json` literally cannot resolve `@symnav/backend-typescript`. ESLint provides clear early errors; project references are the unbypassable structural backstop.
- **Editor config committed.** `.vscode/settings.json` (formatOnSave + Prettier default + ESLint fixAll) and `.vscode/extensions.json` (recommend Prettier + ESLint extensions) are part of Stage 0 to give contributors a consistent dev experience. CI is still the source of enforcement.
- **AGENTS.md is the contributor guide** (with `CLAUDE.md` symlinked). It points readers at the functional spec and stages doc for product/roadmap context, lists day-to-day commands and test conventions, and restates the dependency-direction rule near the bottom.

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

## Stage 1.5 — Foundation Hardening

**What we deliver.** No new command. A consolidation pass over the code Stage 1 shipped, locking the IR contract and the workspace/CLI scaffolding before Stage 2 multiplies them across three more commands. Seven targeted deepenings, each independently landable, each leaving the `overview` command behaviourally identical.

**Why this stage.** Stage 1 was the walking skeleton — its real output was the IR shape, the renderer rules, the language-backend interface, and the CLI scaffolding. Those decisions were made under the pressure of shipping one command. Stage 2 (`resolve`, `def`) is the first stage to *consume* them: two commands that reuse the IR, the workspace path-resolution dance, the error-routing scaffold, and the renderer-selection logic. Every shallow seam left in place now gets copied two-to-four more times before Stage 5. The cheapest moment to deepen a seam is before it has callers; that moment is now.

This stage deliberately breaks the *letter* of the "iterate vertically" principle — it produces no new user-facing slice — but honours its *spirit*: it keeps the architecture honest so later vertical slices stay cheap. It is not scaffolding for a later stage; it is deepening of code already in production.

**In scope.**

- **Self-rendering errors.** Error types carry their user-facing context at the point they are thrown and own how they render into the spec's "Cannot answer:" voice. The CLI's per-error type-check ladder and the multi-overload error formatter collapse to a single dispatch.
- **Workspace-owned input-path resolution.** The resolve-relative / file-exists / inside-workspace / not-ignored sequence becomes a single workspace operation that returns a workspace-relative path or fails. Every later command starts from that one call instead of re-implementing the policy.
- **Workspace construction collapses to a factory.** The `Workspace` interface plus its abstract base plus its two zero-override concrete subclasses become a single `createWorkspace` factory over an injected file-system port — the shape the Stage 1 plan originally called for. The unused polymorphism leaves the `@symnav/core` public surface.
- **A shared command pipeline.** Workspace lifecycle, error dispatch, output-stream selection, and exit-code policy move out of the `overview` action into one reusable command-runner seam. Each command then supplies only its result-computing function and its renderer pair.
- **Ignore rules consolidate behind one module.** The four-file ignore cluster and the `.git/` rule currently duplicated in two places become a single workspace-ignore module with a build step and an `isIgnored` query. Three internal types leave the `@symnav/core` public surface; one cohesive type replaces them.
- **Signatures become line arrays.** A symbol's signature in the IR becomes an ordered list of single-line strings rather than one possibly-multi-line string. The language-backend interface enforces single-line-per-element; the renderer applies tree glyphs and indentation per line. Includes the multi-line renderer test deferred during Stage 1.
- **Symbol kinds split into role and native label.** The IR's symbol-kind field stops hard-coding TypeScript-specific labels. It carries a small language-agnostic role — the few buckets the renderer actually reasons about — plus a backend-supplied native label for faithful display. The TypeScript-flavoured label set moves into the TypeScript backend, so `core` need not change when a future backend lands.

**Out of scope.** Any new command. Any change to `overview`'s observable output for inputs Stage 1 already handled — multi-line signatures are new *correct* output, not a change to existing output. New language backends; the symbol-kind split makes `core` ready for them but adds none.

**Done when.** All seven deepenings have landed. `overview` produces byte-identical output to Stage 1 for every Stage 1 fixture. The `@symnav/core` public surface exports only what cross-package callers use. CI is green. A contributor adding a Stage 2 command reuses the command pipeline, the workspace path-resolution call, and the self-rendering error types without re-deriving them.

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

## Stage 3.5 — Anonymous Usage Telemetry

**What we deliver.** Every command invocation appends one shape-only usage event to a global append-only log on the user's machine, and a hidden `symnav stats` command aggregates that log into a usage summary. No new navigation behavior. The six commands produce byte-identical output whether telemetry is on or off.

**Why this stage.** The tool now has four working commands and its first real user — its own author, using it for development. Before adding more surface in Stage 4, we want evidence of what is actually used and how. This stage builds the local measurement layer that produces that evidence. The cohort is small and known (the author plus a few trusted users), so this is private-beta instrumentation, not anonymous fleet analytics. A full endpoint-based collection pipeline is a deliberate later step; this stage builds only the capture and local-read halves, with an event schema designed to be the same one a future endpoint would ingest.

Doing this at 3.5 — before `context` and `graph` — means the two heaviest commands are measured from their first day, and the capture seam is locked while there are four call sites to thread it through instead of six.

**Design decisions (locked during grilling).**

- **Subject.** Small known cohort. Capture now, transport later. The local event schema is the upload schema — nothing is recorded locally that could not later be uploaded.
- **Capture point.** The single `runCommand` seam in `apps/cli`. One event per invocation, covering all three outcomes (success, user-facing error, crash).
- **Shape, not content.** Events record command, timestamp, duration, outcome, error reason (enum, not free text), which flags were set (not their string values), result-size counts, argument *shape* (kind and length bucket), `workspaceId`, `machineId`, `sessionId`, `symnavVersion`, and `schemaVersion`. Never symbol names, file paths, query strings, or source previews.
- **Identity.** `machineId` is a random UUID generated once and persisted to `~/.symnav/machine-id`. `workspaceId` is a hash of the git remote URL, falling back to an abs-path hash when there is no remote. The same workspace on two machines yields the same `workspaceId` and different `machineId`. Both are computed at the `runCommand` seam and handed to the recorder; the telemetry package never reads git itself.
- **Package.** A new `@symnav/telemetry` leaf package depends on nothing internal. It owns the `UsageEvent` type, the `Recorder` interface, a node append-file recorder with its own narrow write port (it does not reuse or extend `core`'s read-only `FileSystem`), and the stats aggregator. `apps/cli` gains it as an allowed dependency; `renderer` and `backend-typescript` never touch it.
- **Storage.** A single global JSONL file at `~/.symnav/usage.jsonl`, location built from Node's `os.homedir()` (cross-platform, no invented per-OS paths), the base dir overridable via `SYMNAV_STATE_DIR` for tests. One global file across all projects, grouped by `workspaceId` at read time.
- **Write semantics.** Synchronous append, one event per invocation, emitted after the result is known and before any `exit`. The recorder swallows every internal fault: a telemetry error never throws into the command path, never writes to stdout or stderr, and never changes the exit code.
- **Opt-out.** On by default. `SYMNAV_TELEMETRY=0` makes the recorder a fully inert no-op — no event built, no directory created, no file touched. Disclosure lives in the README; there is no runtime notice, to keep output clean and deterministic. The tool's own test suites default to disabled.
- **Reader.** `symnav stats` is registered but hidden from `--help`, keeping the agent-facing surface exactly the six navigation commands. It prints a usage summary (per-command counts and share, outcome breakdown, duration avg/p50/p95, distinct workspace count, version spread, date range) and supports `--json`. It does not record its own invocation.
- **Determinism.** The recorder takes an injected clock and id generator so events are byte-stable under test.

**In scope.**
- The `@symnav/telemetry` package: `UsageEvent` type, `Recorder` interface, node append-file recorder with its own write port, stats aggregator.
- Capture wired into `runCommand`, with `workspaceId`/`machineId` computed at that seam.
- The `SYMNAV_TELEMETRY` kill switch and `SYMNAV_STATE_DIR` override.
- The hidden `symnav stats` command (summary + `--json`).
- README disclosure of what is collected, where it is stored, and how to disable it.
- Tests at three layers: unit (event built correctly from injected clock/id, no-op when disabled, write errors swallowed, aggregator math), integration (real append and read-back against a tmp `SYMNAV_STATE_DIR`), e2e (built binary appends one correct line; `SYMNAV_TELEMETRY=0` writes nothing; command stdout/stderr/exit-code identical with telemetry on versus off).

**Out of scope.**
- Any network, upload endpoint, or transport. Getting a user's log to the author is manual export only.
- Any consent UI or runtime notice beyond README disclosure and the env kill switch.
- Log rotation or size cap.
- `stats` filter flags (`--since`, `--command`, `--workspace`).
- Any raw source identifier — symbol names, file paths, query strings, previews.
- Any change to the six commands' observable output.

**Done when.** Every command emits one shape-only event through the `runCommand` seam. `SYMNAV_TELEMETRY=0` makes telemetry fully inert. Hidden `symnav stats` aggregates the global JSONL into a usage summary. Telemetry faults never touch stdout, stderr, or exit codes. The six commands produce byte-identical output with telemetry on or off. The three test layers and CI are green.

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
| 1.5 | Foundation hardening | IR contract, workspace factory, and error/pipeline scaffolding deepened before Stage 2 multiplies them |
| 2 | `resolve`, `def` | Canonical symbol IDs and overload disambiguation |
| 3 | `refs` | Cross-file reference enumeration and pagination |
| 3.5 | Anonymous usage telemetry | Shape-only event capture at the CLI seam + hidden `stats` reader |
| 4 | `context` | Composition + direct callers/callees + git history |
| 5 | `graph` | Multi-hop traversal and path-based pagination |
| 6 | Release | Distribution, documentation, performance baseline |

Each stage is independently releasable. No stage's scope expands to anticipate a later stage's needs.
