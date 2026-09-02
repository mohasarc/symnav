# Symnav Daemon Architecture Functional Spec

## Goal

Restructure the merged daemon work so each concern lives in the package that owns it: a self-contained daemon package that knows nothing about symbols, a core that knows nothing about daemons, a TypeScript backend that holds only TypeScript-specific logic, and a CLI app that only composes. The daemon's user-facing behavior is defined in `daemon-functional-spec.md` and does not change. This is refactor work: not a rewrite of the daemon, not a change to any command's output or timing, and not a new language backend. This spec defines product behavior for contributors and hosts of the packages; implementation choices live in the phased plans.

## Primary User

**Contributors** changing symnav. Their default experience: a package boundary tells them where a concern belongs, and the build refuses an import that crosses the locked dependency graph.

**Hosts** composing the packages into a runnable product. The CLI app is the first host. A future host (editor extension, MCP server, benchmark harness) composes the same packages the same way. No host reaches into another package's internals.

End users of the `symnav` binary observe no change from this work.

## Core Guarantees

### Behavior is unchanged

This is a refactor. Every command, daemon lifecycle action, diagnostic record, telemetry event, and failure path behaves as it does today.

```text
Given the same workspace, arguments, environment, and daemon state, output bytes,
exit code, execution mode, and lifecycle outcome are identical before and after.
```

Correct: a restructuring change passes the existing e2e parity and daemon suites without touching a single expectation. Incorrect: a restructuring change "fixes" a queue, eviction, timeout, or path while moving code.

There is no "it was obviously a bug" override. Behavior defects found during restructuring are recorded in `daemon-follow-ups-functional-spec.md` and changed separately.

### The daemon package depends on nothing internal

The daemon package imports no other symnav package. It moves bytes for an executor it is handed; it does not know what a symbol, workspace snapshot, or backend is.

```text
@symnav/daemon may import: (nothing internal)
```

Correct: the daemon logs a worker's refresh counters as an opaque diagnostics record supplied by the executor. Incorrect: the daemon's protocol names a core type to describe those counters.

There is no exception for "just a type".

### Core knows nothing about daemons or processes

Core answers questions about a workspace and its symbols. It has no concept of a background process, socket, registry, warm-up, or route. Retaining state across requests means keeping a core object alive; core does not ask its host how to persist anything.

```text
Core has no persistence port, no daemon port, and no notion of warm vs cold.
Warm = the same session object answers again. Cold = a new session object.
```

There is no persistence abstraction until a second consumer of one exists.

### A language backend holds only language-specific logic

A concept that another language could share lives in core as a base the backend extends. The backend supplies only what depends on the language's toolchain.

```text
Shared in core: file revision tracking, prepared-file index, declarations-by-identity,
transactional index publication, project-membership graph with input invalidation,
turn-scoped query cache lifecycle.
TypeScript-only: extraction from TypeScript syntax trees, tsconfig parsing (extends,
references, path aliases, include/exclude), program and language-service creation,
semantic query bodies.
```

### The CLI app is composition only

`apps/cli` parses command-line syntax, resolves environment (state directory, daemon enabled), creates concrete dependencies, wires packages together, and prints. It holds no daemon policy, no workspace policy, and no navigation logic.

```text
A decision about routing, admission, ownership, delivery, memory, or lifetime that
lives in apps/cli is a defect.
```

### Every threshold has one owner and a recorded reason

Numeric limits (memory caps, spool caps, deadlines, idle timeout, probe timeout, trace retention, replacement circuit, reattachment attempts) live in one policy object inside the daemon package, each with a stated reason in a policy record under `plans/`. Tests override the policy object; users cannot.

```text
No CLI flag, environment variable, or config file tunes a daemon threshold.
```

This restates the no-tuning rule from `daemon-functional-spec.md`; it is not relaxed here.

## Scope

### Included

- New `@symnav/daemon` package owning entry points, process launch, election, registry, transport, worker threads, admission, queueing, delivery, spooling, resource supervision, lifetime, diagnostics, and its own clock.
- Executor contract defined by the daemon package; CLI implements it.
- Executor reaches the daemon's worker as an injected module location, dynamically loaded.
- CLI keeps argv classification and hands the daemon client a workspace root plus argv.
- Core `WorkspaceSession` replacing the CLI's request-scope factory.
- Core revisioned-backend base, project-graph base, turn-scoped cache; TypeScript backend extends them. `WorkspaceSourceCache` moves to core.
- State-directory resolution moves from telemetry to the CLI; telemetry and daemon receive a path.
- Daemon lifecycle rendering moves to `@symnav/renderer`.
- Admission and client routing restructured as ordered guard lists with one closed rejection vocabulary.
- `WorkspaceDaemon` split into process coordinator, accepted-execution session, delivery session, worker-generation manager, activity projector.
- `LocalDaemonTransport` split into codec/validator, lifecycle client, execution client, result receiver, socket client, socket server.
- One owner each for command-name vocabulary, lock-ownership check, retry-safety decision, and `DaemonExecutionFailureCode` (worker variant renamed).
- Dependency table, ESLint boundaries, project references, meta-tests, `CLAUDE.md`, and `symnav-stages.md` updated together with the package introduction. Telemetry added to the table.

### Excluded

- Any change to navigation command output, exit codes, or `daemon start|status|stop` output.
- Renaming `@symnav/renderer`. Revisit when a second output family exists.
- A persistence port in core or an on-disk index for cold runs.
- New CLI flags or environment variables.
- A second language backend.
- Any restructuring that changes an e2e parity or daemon suite expectation.
- Behavior changes surfaced by the reviews. Specified in `daemon-follow-ups-functional-spec.md`; they land after this restructuring.

## Interaction Model

### What a host provides to the daemon package

- An executor: given argv, working directory, and telemetry flag, produces an ordered stream of stdout/stderr byte records and an exit code; can also release transient caches on request.
- The location of a module that constructs that executor, so the daemon's worker can load it in another thread or process.
- A state directory path.
- The product version, for compatibility checks.
- Per invocation: a workspace root and argv, or a control action (`start`, `status`, `stop`).

### What a host receives

- `execute(workspaceRoot, argv)`: a result identical in bytes to local execution, produced warm, cold, or by fallback. The host does not learn which route was taken except through the execution mode recorded for telemetry.
- `control(action)`: a lifecycle report the host renders.

### What a host must not do

- Read or write registry, socket, spool, or log files directly.
- Decide warm vs cold.
- Import from the daemon package's internal modules; only its public surface.

### Locked dependency graph

| Package                      | May depend on (internal)                                                          |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `@symnav/core`               | (nothing)                                                                         |
| `@symnav/daemon`             | (nothing)                                                                         |
| `@symnav/telemetry`          | (nothing)                                                                         |
| `@symnav/renderer`           | `@symnav/core`, `@symnav/daemon`                                                  |
| `@symnav/backend-typescript` | `@symnav/core`                                                                    |
| `symnav` (apps/cli)          | `@symnav/core`, `@symnav/daemon`, `@symnav/telemetry`, `@symnav/renderer`, `@symnav/backend-typescript` |
| `@symnav/testing`            | (nothing)                                                                         |

A forbidden import fails both `pnpm typecheck` and `pnpm lint`.

## Output Format

### Package layout after restructuring

```text
packages/core
  workspace, workspace session, revisioned backend base, project-graph base,
  turn-scoped cache, source cache, navigation IR, backend ports
packages/daemon
  entries, launcher, election, registry, transport (client, server, codec),
  admission, queue, ledger, execution session, delivery session, spool,
  resource supervisor, worker generations, lifetime, diagnostics, policy, clock
packages/backend-typescript
  TypeScript extraction, tsconfig graph, semantic queries
packages/renderer
  text and JSON formatters, including daemon lifecycle reports
packages/telemetry
  usage events, recorder, aggregation
apps/cli
  argv classification, environment resolution, dependency creation, entry
  module for the daemon executor, command registration, printing
```

### Policy record

`plans/005/daemon-policy.md` lists every threshold with value and reason. A threshold absent from the record is a defect.

## Cross-cutting Concerns

### Verification baseline

The passing e2e parity and daemon suites on main are the baseline. The full-suite teardown flake and the unhandled daemon rejection are fixed before restructuring starts, so that baseline is green. Restructuring matches it exactly; a restructuring change that needs a test expectation changed is mis-scoped.

### Documentation

`CLAUDE.md` repo layout and dependency table, `plans/000/symnav-stages.md` package list update together with the introduction of `@symnav/daemon`.

## Daemon Package Extraction

**Purpose.** Give daemon policy and mechanism one home with an enforced boundary.

**Produces.** `@symnav/daemon` with a public surface of: client (execute, control), process entry, worker entry, executor contract, policy object, lifecycle report shapes.

**Does not produce.** Any navigation logic, any dependence on core, any knowledge of Commander syntax.

**Example.** A contributor adds a new admission check. They add one guard in the daemon package and one rejection code. Nothing in `apps/cli` changes.

**Edge cases.** Tests and benchmarks that imported daemon modules by deep relative path switch to the package's public surface or move into the package.

## Executor Contract and Module Injection

**Purpose.** Let the daemon run commands without knowing what they are.

**Produces.** The daemon defines the executor's shape. The CLI implements it by re-parsing argv through the normal command program with retained backends. The CLI passes the location of its executor module; the daemon forwards it to the spawned process and worker thread, which load it and verify the expected export exists.

**Does not produce.** A typed navigation request. A second execution path that bypasses the command program.

**Edge cases.** Module missing or export absent: the worker reports a startup failure with a closed failure code; the daemon publishes failed startup; ordinary commands keep executing locally.

## Client Routing Boundary

**Purpose.** Keep CLI syntax in the CLI and daemon routing in the daemon.

**Produces.** CLI classifies argv into local, control, or workspace; extracts `--cwd`; resolves the workspace root via core. Daemon client receives the root and argv and decides warm, cold, cold-plus-trigger, or fallback.

**Does not produce.** A daemon that parses argv for anything but forwarding. A CLI that reads registry records.

**Defaults.** Unchanged from `daemon-functional-spec.md` routing table.

## Workspace Session in Core

**Purpose.** Make retention a core object rather than CLI wiring.

**Produces.** A session owning the workspace catalog and backends; prepares a scope (workspace, snapshot, router, refresh summary) for a start directory, with optional file selection. Cold runs create one per process; the daemon's worker keeps one alive.

**Does not produce.** Any persistence beyond the process lifetime.

## Revisioned Backend Base

**Purpose.** Move language-agnostic retention out of the TypeScript backend.

**Produces.** A core base that diffs file revisions, asks the subclass to prepare only added or changed files, publishes the index transactionally, tracks declarations by identity, and scopes a query cache to one turn. A core project-graph base that discovers configuration units, invalidates on input change, maps files to projects, and holds an inferred fallback project. The TypeScript backend extends both.

**Does not produce.** Changes to what any command returns. A second backend.

**Edge cases.** A backend that cannot prepare partially implements prepare as full rebuild; the base does not require partial support.

## State Directory and Clock Ownership

**Purpose.** Stop telemetry acting as a shared utilities package.

**Produces.** CLI resolves `SYMNAV_STATE_DIR` or `~/.symnav` once and passes the path to telemetry and daemon. Daemon owns its wall and monotonic clock. Telemetry keeps only its own path helpers.

## Lifecycle Rendering

**Purpose.** Keep all formatting in the renderer package.

**Produces.** Text and JSON rendering of start, status, and stop reports in `@symnav/renderer`, byte-identical to current output.

## Guard-List Admission and Routing

**Purpose.** Make the check order readable and each check testable alone.

**Produces.** Admission: an ordered list (authenticated, worker ready, memory not paused, not draining, not a conflicting duplicate) where the first failing guard stops with a rejection code. Routing: an ordered list (record present, not starting, version compatible, responsive) producing warm, cold with reason, or fallback with reason. One closed rejection vocabulary owns "safe to retry locally".

**Does not produce.** Chains for startup election, result delivery, or wire framing; those stay state machines.

## Summary

| Item                          | One line                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- |
| `@symnav/daemon`              | Zero-dependency package owning every daemon concern                      |
| Executor contract             | Daemon-defined; CLI implements; injected as a module location            |
| Routing boundary              | CLI classifies argv; daemon client routes                                |
| `WorkspaceSession`            | Core owns retention as an object; no persistence port                    |
| Revisioned backend base       | Core owns revision diff, index, project graph, turn cache                 |
| State dir and clock           | CLI resolves path; daemon owns its clock; telemetry is a leaf            |
| Lifecycle rendering           | Moves to renderer; renderer may depend on daemon                          |
| Guard lists                   | Admission and routing as ordered guards with one rejection vocabulary    |
| Policy record                 | All thresholds in one object, reasons in `plans/005/daemon-policy.md`    |
| Behavior                      | Unchanged; defects found while restructuring are tracked separately      |
