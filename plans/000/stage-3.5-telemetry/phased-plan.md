# Stage 3.5 — Anonymous Usage Telemetry: Phased Plan

Capture one shape-only usage event per command invocation into a global append-only log, and add a hidden `stats` reader that aggregates it. Source: [`plans/000/symnav-stages.md`](../symnav-stages.md) § Stage 3.5.

## Goal

After this plan, every `symnav` invocation appends one shape-only `UsageEvent` (command, timestamp, duration, outcome, error reason, flag names, result-size counts, arg shape, `workspaceId`/`machineId`/`sessionId`, versions) to `~/.symnav/usage.jsonl`. `SYMNAV_TELEMETRY=0` makes the whole path inert — no event built, no directory created. A telemetry fault never reaches stdout, stderr, or the exit code, and the six navigation commands produce byte-identical output whether telemetry is on or off. A hidden `symnav stats` command reads the global log and prints a usage summary (text or `--json`), without recording itself.

## Context

- **Capture seam.** `apps/cli/src/command.ts` — `runCommand<Result, Args>(command, invocation)`. Single point all four commands flow through. Today: `createWorkspace` → `compute` → render to `context.stdout`; `handleError` writes `Cannot answer: …` + `exit(1)` for `UserFacingError`, raw message + `exit(2)` otherwise.
- **Command shape.** `Command<Result, Args>` = `{ compute, renderText, renderJson }`. Four object literals: `overviewCommand` (`{file}` → `OverviewFileSymbols`), `resolveCommand` (`{query, fuzzy}` → `ResolveResult`), `defCommand` (`{symbolId}` → `DefinitionResult`), `refsCommand` (`{symbolId, page, pageSize, all, fullLines}` → `RefsResult`). Result types in `@symnav/core` `intermediate-representation/types.ts` and `references.ts`.
- **Injection seams.** `ProgramContext` (stdout/stderr/cwd/exit), `ProgramDependencies` (`{fs, backends}`). `program.ts` `buildProgram` builds defaults, reads version via `readPackageVersion()`, registers commands. Each `register-*-command.ts` calls `runCommand`.
- **Errors.** Abstract `UserFacingError` (`get reason()`), telemetry-unaware. Subclasses across core carry distinct class names — `NotInWorkspaceError`, `FileNotFoundError`, `IgnoredFileError`, `OutsideWorkspaceError`, `UnsupportedFileError`, `SymbolNotFoundError`, `InvalidSymbolIdError`, `InvalidPageRequestError`, `PageOutOfRangeError`, `UnreadableDirectoryWarningCandidateError`. `constructor.name` is the stable discriminant (no minifier — `tsc --build`, ESM).
- **Dependency graph enforcement.** `eslint.config.mjs` (`boundaries`) + per-package `tsconfig.json` `references`, both asserted from disk by `meta-tests/src/lint-rule.test.ts` and `meta-tests/src/project-refs.test.ts`. Root `tsconfig.json` lists all packages.
- **Test infra.** Vitest. Unit colocated (`*.test.ts`). Integration under `<pkg>/test/integration/`. E2e under `apps/cli/test/e2e/` via `runSymnavBinary(args, {cwd})` (`@symnav/testing`, `spawnSync`). Seam already has `apps/cli/test/integration/commands/run-command.test.ts` with `createFakeProgramContext`, `FakeLanguageBackend`, `InMemoryFileSystem`.

**Design refinements vs. the stage's locked decisions** (surfaced during planning, called out where they apply):

- **Timestamp + duration are seam-owned, not recorder-owned.** `timestamp` = invocation start; you cannot stamp a start time at record-time (record runs after `compute`). The seam captures `startedAt = clock.now()` once (it already needs it for duration) and passes both `timestamp` and `durationMs` in the event input. The recorder owns only `sessionId` (injected id-generator, once per process) and `schemaVersion`. The shared `clock` lives on `ProgramDependencies`.
- **`json` flag merged at the seam.** `describeArgs(args)` only sees the command's own args; `--json` arrives as `invocation.json`. The seam appends `"json"` to `argShape.flags` so all flag names land in one place.

## Phases

---

## Phase 1 — `@symnav/telemetry` package and event schema

**Behavior delivered.** A new leaf package exists, builds, and is wired into the dependency graph as a `cli`-only dependency. It exports the `UsageEvent` schema (and sub-shapes) and `SCHEMA_VERSION`. Nothing consumes it yet.

**Test cases.**
- *Project references include telemetry* — `meta-tests/src/project-refs.test.ts`: `apps/cli/tsconfig.json` references the four production libs (adds `../../packages/telemetry`); `packages/telemetry/tsconfig.json` has no internal references (leaf); `packages/telemetry/tsconfig.test.json` references `["./tsconfig.json", "../testing"]`; no production tsconfig references `testing` (telemetry included in the swept list). Unit (meta). No new fixture.
- *Boundaries allow cli→telemetry, forbid renderer→telemetry* — `meta-tests/src/lint-rule.test.ts`: a `cli` file importing `@symnav/telemetry` lints clean; a `renderer` file importing `@symnav/telemetry` reports one `boundaries/dependencies` violation. Unit (meta).
- *Schema exports* — `packages/telemetry/src/usage-event.test.ts`: `SCHEMA_VERSION` is a positive integer; a literal typed as `UsageEvent` compiles with the expected keys. Unit.

**Components.**

`packages/telemetry/` mirrors an existing leaf (`packages/core`): `package.json` (`@symnav/telemetry`, private, ESM, `main`/`types`/`exports`/`files`, scripts identical to core, `devDependencies: { "@symnav/testing": "workspace:*" }`, no internal `dependencies`), `tsconfig.json` (extends base, `references: []`), `tsconfig.test.json` (extends, `references: ["./tsconfig.json", "../testing"]`), `src/index.ts`.

Schema (`src/usage-event.ts`):

```ts
export const SCHEMA_VERSION = 1;

export type Outcome = "success" | "user_error" | "crash";
export type ArgKind = "symbol_id" | "path" | "bare" | "empty";
export type LengthBucket = "empty" | "short" | "medium" | "long";

export interface ArgShape {
  readonly kind: ArgKind;
  readonly lengthBucket: LengthBucket;
  readonly flags: readonly string[];
}

export interface UsageEvent {
  readonly schemaVersion: number;
  readonly symnavVersion: string;
  readonly command: string;
  readonly timestamp: number; // epoch ms, invocation start
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly errorReason?: string; // constructor.name | "crash"; omitted on success
  readonly argShape: ArgShape;
  readonly resultCounts?: Readonly<Record<string, number>>; // omitted on non-success
  readonly workspaceId: string;
  readonly machineId: string;
  readonly sessionId: string;
}
```

Graph wiring: `eslint.config.mjs` `packages` array gains `{ name: "@symnav/telemetry", type: "telemetry", dir: "packages/telemetry" }`; `productionRules()` `cli` `allow.to` gains `"telemetry"`; `testRules()` `cli` `allow.to` gains `"telemetry"`. Root `tsconfig.json` `references` gains `./packages/telemetry`. `apps/cli/tsconfig.json` `references` gains `../../packages/telemetry`. `apps/cli/package.json` `dependencies` gains `"@symnav/telemetry": "workspace:*"`.

**Commit plan.**
1. `test: expect @symnav/telemetry in graph config` — update both meta-tests to assert the telemetry refs and boundaries. Tests-first (red).
2. `chore: scaffold @symnav/telemetry package` — package.json, tsconfigs, empty `src/index.ts`, root tsconfig ref; `pnpm install`. New package, no graph edge yet.
3. `chore: register @symnav/telemetry as a cli dependency` — eslint elements/rules, cli tsconfig ref, cli package.json dep. Config-only; greens the meta-tests. (Split from 2: scaffolding the package and wiring the edge are distinct logical changes.)
4. `feat(telemetry): add UsageEvent schema and SCHEMA_VERSION` — `usage-event.ts` + exports + its unit test. Type-only; no consumers.

**Done when.** `pnpm build`/`lint`/`typecheck`/`test` green. Meta-tests assert telemetry in the graph. `@symnav/telemetry` exports the schema. `renderer`/`backend` importing telemetry still fails boundaries.

---

## Phase 2 — Write side: recorder, write port, state-dir resolver

**Behavior delivered.** Given an event input, the node recorder appends exactly one JSON line to `usage.jsonl` under the resolved state dir, creating the directory if missing, stamping `sessionId`/`schemaVersion`, and swallowing every fault. The state-dir location honors `SYMNAV_STATE_DIR` then `os.homedir()/.symnav`.

**Test cases.**
- *Builds a complete event from input* — `src/recorder.test.ts`: `NodeUsageRecorder` with a capturing fake write port, fixed `IdGenerator` (`"session-1"`), records an input → one `appendLine` call whose line `JSON.parse`s to the input plus `sessionId: "session-1"`, `schemaVersion: 1`. Unit.
- *Stable key order* — same test asserts the raw line string equals a fixed expected string (locks JSON key order for byte-stability). Unit.
- *Swallows write faults* — write port throws on `ensureDir` and on `appendLine` → `record` does not throw, nothing else observable. Unit.
- *State-dir resolution* — `src/state-dir.test.ts`: `SYMNAV_STATE_DIR=/tmp/x` → `/tmp/x`; unset → `<homedir>/.symnav`; `usageLogPath(dir)` → `<dir>/usage.jsonl`. Unit (inject `env` + `homedir`).
- *Real append + readback* — `test/integration/recorder.integration.test.ts`: `NodeTelemetryWritePort` + recorder against a tmp `SYMNAV_STATE_DIR`; record two events → file has two lines, each a valid event; dir created when absent. Integration.

**Components.**

```ts
// src/clock.ts
export interface Clock {
  now(): number; // epoch ms
}

// src/id-generator.ts
export interface IdGenerator {
  next(): string;
}

// src/write-port.ts
export interface TelemetryWritePort {
  ensureDir(dir: string): void;
  appendLine(filePath: string, line: string): void;
}
export class NodeTelemetryWritePort implements TelemetryWritePort {
  ensureDir(dir: string): void;
  appendLine(filePath: string, line: string): void; // sync, "<line>\n"
}

// src/recorder.ts
export interface UsageEventInput {
  readonly symnavVersion: string;
  readonly command: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly errorReason?: string;
  readonly argShape: ArgShape;
  readonly resultCounts?: Readonly<Record<string, number>>;
  readonly workspaceId: string;
  readonly machineId: string;
}
export interface Recorder {
  record(input: UsageEventInput): void;
}
export class NodeUsageRecorder implements Recorder {
  constructor(
    writePort: TelemetryWritePort,
    idGenerator: IdGenerator,
    stateDir: string,
  );
  record(input: UsageEventInput): void;
}

// src/state-dir.ts
export function resolveStateDir(env: NodeJS.ProcessEnv): string;
export function usageLogPath(stateDir: string): string;
```

Recorder builds the `UsageEvent` object with keys in schema-declaration order (`schemaVersion`, `symnavVersion`, `command`, `timestamp`, `durationMs`, `outcome`, `errorReason`, `argShape`, `resultCounts`, `workspaceId`, `machineId`, `sessionId`), generating `sessionId` once at construction via `idGenerator.next()`. `errorReason`/`resultCounts` omitted (not `undefined`-keyed) when absent. The whole `record` body is wrapped so no fault escapes.

**Note (refines stage's "recorder takes a clock").** Recorder takes an `IdGenerator` (for `sessionId`), not a `Clock`. Timestamp/duration are seam-owned (see Context). Byte-stability under test comes from the fixed id-generator here plus the seam's fixed clock in Phase 5.

**Commit plan.**
1. `test(telemetry): recorder, write port, and state-dir specs` — unit + integration tests (red).
2. `feat(telemetry): add Clock, IdGenerator, and write port` — `clock.ts`, `id-generator.ts`, `write-port.ts` + exports. Type/port definitions; node write port impl.
3. `feat(telemetry): add state-dir resolver` — `state-dir.ts` + exports. Greens state-dir specs.
4. `feat(telemetry): add NodeUsageRecorder` — `recorder.ts` + exports. Greens recorder specs. (Depends on the ports/clock landing first.)

**Done when.** Recorder appends one stable-keyed line per event to a tmp dir, creates missing dirs, swallows faults; resolver honors env + homedir. CI green.

---

## Phase 3 — Command telemetry descriptor

**Behavior delivered.** Every `Command` self-describes its telemetry shape: a `name`, a pure `describeArgs(args) → ArgShape`, and a pure `countResults(result) → Record<string, number>`. Not yet consumed by the seam.

**Test cases.**
- *Arg classification* — `apps/cli/test/integration/commands/arg-shape.test.ts` (or colocated unit): `classifyArgKind("a/b.ts") → "path"`, `"File.ts::Foo" → "symbol_id"`, `"foo" → "bare"`, `"" → "empty"`; `lengthBucketOf` boundaries at 0/≤20/≤80/>80 → `empty/short/medium/long`. Unit.
- *Per-command describeArgs* — for each command: `overviewCommand.describeArgs({file:"src/a.ts"})` → `{kind:"path", lengthBucket:"short", flags:[]}`; `resolveCommand.describeArgs({query:"Foo", fuzzy:true})` → `flags:["fuzzy"]`; `defCommand.describeArgs({symbolId:"a.ts::Foo"})` → `{kind:"symbol_id", …, flags:[]}`; `refsCommand.describeArgs({symbolId:"a.ts::Foo", page:2, pageSize:undefined, all:true, fullLines:false})` → `flags:["all","page"]` (sorted, presence-only, no values). Unit.
- *Per-command countResults* — `overviewCommand.countResults(result)` → `{symbols:<total tree nodes>}` (recursive); `resolveCommand` → `{symbols:n, files:m}`; `defCommand` → `{definitions:n}`; `refsCommand` → `{total, page:<refs on page>, pages}`. Unit, using small hand-built result objects. Note: `flags` never carries values; counts never carry names/paths.

**Components.**

```ts
// apps/cli/src/command.ts — extend Command
export interface Command<Result, Args> {
  readonly name: string;
  describeArgs(args: Args): ArgShape;          // ArgShape from @symnav/telemetry
  countResults(result: Result): Record<string, number>;
  compute(ctx: CommandContext<Args>): Promise<Result>;
  renderText(result: Result): string;
  renderJson(result: Result): string;
}

// apps/cli/src/telemetry/arg-shape.ts
export function classifyArgKind(value: string): ArgKind;
export function lengthBucketOf(value: string): LengthBucket;
```

Each command object adds `name` and the two functions. `describeArgs` builds `{kind, lengthBucket, flags}` from its single positional arg + its own boolean/presence flags (not `--json` — merged later at the seam). `flags` sorted. `countResults` reads the result's existing fields (recursive node count for `overview`).

**Commit plan.**
1. `test(cli): arg-shape helper specs` — `arg-shape.test.ts` (red).
2. `feat(cli): add arg-shape classifiers` — `telemetry/arg-shape.ts`. Greens helper specs.
3. `test(cli): command descriptor specs` — per-command `name`/`describeArgs`/`countResults` tests (red).
4. `feat(cli): add telemetry descriptor to commands` — extend `Command` interface, implement `name`/`describeArgs`/`countResults` on all four commands, update `StubCommand` and any fake commands in tests to satisfy the interface. Interface-member addition requires its implementations in the same commit; no change to `compute`/`renderText`/`renderJson`.

**Done when.** Each command reports its name, arg shape, and result counts; helpers cover the four kinds and four buckets. Output behavior unchanged. CI green.

---

## Phase 4 — Seam identity: enable switch, machineId, workspaceId

**Behavior delivered.** `apps/cli` can decide whether telemetry is enabled and compute `{workspaceId, machineId}` for an invocation — `machineId` persisted to `<stateDir>/machine-id`, `workspaceId` from the git remote with abs-path fallback. Standalone, not yet wired into the seam.

**Test cases.**
- *Enable switch* — `apps/cli/src/telemetry/is-telemetry-enabled.test.ts`: `SYMNAV_TELEMETRY="0"` → false; unset → true; `"1"`/any-other → true. Unit.
- *machineId persistence* — `telemetry-identity.test.ts` against a tmp `SYMNAV_STATE_DIR`: first resolve creates `machine-id` with a UUID and returns it; second resolve returns the same value (read, not regenerated). Unit/integration.
- *workspaceId from git remote* — with a fake git-remote reader returning `git@github.com:o/r.git`, `workspaceId` = stable hash of that string; same remote on two different roots → same id. Unit.
- *workspaceId fallbacks* — reader returns `undefined` → hash of the workspace root; `workspaceRoot` undefined (workspace creation failed) → hash of `cwd`. Unit.
- *Distinct ids* — `machineId` independent of `workspaceId`; same workspace, different machine-id files → same `workspaceId`, different `machineId`. Unit.

**Components.**

```ts
// apps/cli/src/telemetry/is-telemetry-enabled.ts
export function isTelemetryEnabled(env: NodeJS.ProcessEnv): boolean; // disabled iff SYMNAV_TELEMETRY === "0"

// apps/cli/src/telemetry/telemetry-identity.ts
export interface TelemetryIdentity {
  readonly workspaceId: string;
  readonly machineId: string;
}
export interface GitRemoteReader {
  read(workspaceRoot: string): string | undefined;
}
export class NodeGitRemoteReader implements GitRemoteReader {
  read(workspaceRoot: string): string | undefined; // execFileSync("git",["remote","get-url","origin"],{cwd}), catch → undefined
}
export interface TelemetryIdentityProvider {
  resolve(input: { cwd: string; workspaceRoot: string | undefined }): TelemetryIdentity;
}
export class NodeTelemetryIdentityProvider implements TelemetryIdentityProvider {
  constructor(stateDir: string, gitRemoteReader: GitRemoteReader);
  resolve(input: { cwd: string; workspaceRoot: string | undefined }): TelemetryIdentity;
}
```

`machineId`: read `<stateDir>/machine-id`; if absent, `crypto.randomUUID()`, `ensureDir` + write, return (apps/cli owns this file via node fs — telemetry never touches `machine-id`; it only exports the state-dir resolver `resolveStateDir`, reused here). `workspaceId`: `sha256` hex (truncated) of `gitRemoteReader.read(workspaceRoot)` when present, else of `workspaceRoot ?? cwd`. `GitRemoteReader` injected so tests don't spawn git.

**Commit plan.**
1. `test(cli): telemetry enable + identity specs` — both test files (red).
2. `feat(cli): add isTelemetryEnabled` — predicate + export. Greens enable specs.
3. `feat(cli): add telemetry identity provider` — `telemetry-identity.ts` (provider, git-remote reader). Greens identity specs.

**Done when.** Enable switch reads only `SYMNAV_TELEMETRY=0`; identity computes persisted `machineId` and remote-or-path `workspaceId` with documented fallbacks, git injected for tests. Not yet wired into `runCommand`. CI green.

---

## Phase 5 — Seam capture wiring

**Behavior delivered.** Every invocation through `runCommand`, when telemetry is enabled, records exactly one event — built from descriptor + identity + outcome — before any exit, swallowing telemetry faults. When disabled, nothing is built or written. Command stdout/stderr/exit codes are byte-identical to before.

**Test cases.** (`apps/cli/test/integration/commands/run-command.test.ts`, fake recorder/clock/identity)
- *Success records one event* — outcome `"success"`, `command`=descriptor name, `argShape` (with `"json"` merged when `json:true`), `resultCounts` from `countResults`, `timestamp`=fake start, `durationMs`=fake delta, identity from fake provider; stdout unchanged. Integration.
- *User error* — `compute` throws a `UserFacingError` subclass → event `outcome:"user_error"`, `errorReason`=`constructor.name`, no `resultCounts`; stderr `Cannot answer: …`, exit `1` unchanged. Integration.
- *Crash* — `compute` throws plain `Error` → `outcome:"crash"`, `errorReason:"crash"`, exit `2`, raw message unchanged. Integration.
- *Workspace-creation failure* — loose cwd → `NotInWorkspaceError` before `compute`: one event `outcome:"user_error"`, `errorReason:"NotInWorkspaceError"`, identity resolved with `workspaceRoot: undefined`; existing stderr/exit `1` unchanged. Integration.
- *Disabled is inert* — `telemetryEnabled:false` → recorder never called, identity provider never called (asserted via spies), output identical. Integration.
- *Fault swallowed* — recorder `record` throws → command stdout/stderr/exit unchanged. Integration.
- *Record before exit* — on the error path, `record` is observed before `exit` is called (ordering assertion). Integration.
- *Existing lifecycle tests stay green* — all current `run-command.test.ts` cases pass once migrated to the new dependencies shape (telemetry disabled → identical assertions).

**Components.**

```ts
// apps/cli/src/program-dependencies.ts
export interface ProgramDependencies {
  fs: FileSystem;
  backends: () => readonly LanguageBackend[];
  recorder: Recorder;                       // @symnav/telemetry
  clock: Clock;                             // @symnav/telemetry
  telemetryEnabled: boolean;
  identity: TelemetryIdentityProvider;
  symnavVersion: string;
}
```

`runCommand` restructured: capture `startedAt = clock.now()`; `let workspace: Workspace | undefined`; in `try`, assign `workspace`, build router, `compute`, set `outcome="success"`; in `catch`, classify `outcome`/`errorReason` and retain the error for `handleError`. Then, guarded by `telemetryEnabled`, in a fault-swallowing `try`: compute `durationMs = clock.now() - startedAt`, `identity.resolve({cwd, workspaceRoot: workspace?.root})`, assemble `argShape` (`command.describeArgs(args)` with `"json"` appended to `flags` when `invocation.json`, re-sorted), and `recorder.record({...})` with `resultCounts` only on success. Finally render+write on success, else `handleError`. `handleError` unchanged.

`program.ts` `defaultDependencies()` constructs: `clock = { now: () => Date.now() }`; `telemetryEnabled = isTelemetryEnabled(process.env)`; `stateDir = resolveStateDir(process.env)`; `recorder = new NodeUsageRecorder(new NodeTelemetryWritePort(), { next: () => randomUUID() }, stateDir)`; `identity = new NodeTelemetryIdentityProvider(stateDir, new NodeGitRemoteReader())`; `symnavVersion = readPackageVersion()`. Same `clock` instance is shared (seam uses it for timestamp+duration).

Test support (beside the tests): `fakeDependencies(overrides)` with defaults `telemetryEnabled:false`, no-op recorder, fixed clock (`now` returns a scripted sequence), fake identity provider; `createCapturingRecorder()` collecting recorded events.

**Commit plan.**
1. `test(cli): add telemetry capture fakes` — `fakeDependencies`, capturing recorder, fixed clock helpers (test-only). 
2. `test(cli): seam telemetry capture specs` — new integration cases + migrate existing lifecycle cases to `fakeDependencies` (red where they assert new behavior).
3. `feat(cli): extend ProgramDependencies for telemetry` — add `recorder`/`clock`/`telemetryEnabled`/`identity`/`symnavVersion`; wire `defaultDependencies()` to real implementations. Type + wiring only; `runCommand` not yet using them (compiles; behavior unchanged).
4. `feat(cli): record one usage event per invocation` — restructure `runCommand` to build + emit the event behind the enable guard, swallow faults, record before exit. Greens the capture specs. (Refactor of the seam shape landed in commit 3 separately from the behavior here.)

**Done when.** Enabled → one correct event per invocation across all outcomes, recorded before exit, faults swallowed; disabled → fully inert; output byte-identical. All seam tests green. CI green.

---

## Phase 6 — Read side: log reader and aggregator

**Behavior delivered.** `@symnav/telemetry` can read `usage.jsonl` (skipping malformed lines, missing file → empty) and aggregate events into a pure `UsageSummary`.

**Test cases.**
- *Read + skip malformed* — `src/usage-log-reader.test.ts` (integration against tmp dir): a file with two valid lines and one garbage line → two events; missing file → `[]`. Integration.
- *Aggregate math* — `src/aggregate.test.ts`: per-command counts and share sum to 1 (within rounding); outcome breakdown; duration `averageMs`/`p50Ms`/`p95Ms` over known `durationMs` (nearest-rank percentile, asserted on a fixed list); `distinctWorkspaces` from unique `workspaceId`; `versions` counts per `symnavVersion`; `dateRange` = min/max `timestamp`. Unit.
- *Empty aggregate* — no events → `totalEvents:0`, empty arrays, zeroed duration, `dateRange:null`. Unit.

**Components.**

```ts
// src/usage-log-reader.ts
export interface UsageLogReader {
  read(usageFilePath: string): readonly UsageEvent[];
}
export class NodeUsageLogReader implements UsageLogReader {
  read(usageFilePath: string): readonly UsageEvent[]; // missing → []; malformed line → skipped
}

// src/usage-summary.ts
export interface CommandStat { readonly command: string; readonly count: number; readonly share: number; }
export interface OutcomeStat { readonly outcome: Outcome; readonly count: number; }
export interface DurationStats { readonly averageMs: number; readonly p50Ms: number; readonly p95Ms: number; }
export interface VersionStat { readonly version: string; readonly count: number; }
export interface UsageSummary {
  readonly totalEvents: number;
  readonly perCommand: readonly CommandStat[];
  readonly outcomes: readonly OutcomeStat[];
  readonly duration: DurationStats;
  readonly distinctWorkspaces: number;
  readonly versions: readonly VersionStat[];
  readonly dateRange: { readonly earliest: number; readonly latest: number } | null;
}

// src/aggregate.ts
export function aggregate(events: readonly UsageEvent[]): UsageSummary;
```

`aggregate` is pure (no IO). Percentiles via nearest-rank on sorted `durationMs`. `perCommand` sorted by count desc then name; `versions` similar. Returns data only — no formatting (renderer is walled off from telemetry; `stats` text lives in `apps/cli`, Phase 7).

**Commit plan.**
1. `test(telemetry): log reader + aggregate specs` — both files (red).
2. `feat(telemetry): add UsageSummary type` — `usage-summary.ts` + exports. Type-only.
3. `feat(telemetry): add usage log reader` — `usage-log-reader.ts` + exports. Greens reader specs.
4. `feat(telemetry): add aggregate` — `aggregate.ts` + exports. Greens aggregate specs.

**Done when.** Reader tolerates missing/malformed logs; `aggregate` returns correct counts/shares/percentiles/ranges as pure data. CI green.

---

## Phase 7 — Hidden `stats` command

**Behavior delivered.** `symnav stats` reads the global log, aggregates, and prints a usage summary (text default, `--json` for the raw `UsageSummary`). It is hidden from `--help`, never constructs a workspace, never records itself, and never touches the recorder.

**Test cases.**
- *Hidden from help* — `apps/cli/test/integration/commands/stats/stats-command.test.ts`: top-level `--help` output does not list `stats`; the six navigation commands still listed. Integration.
- *Renders a summary* — with a tmp `SYMNAV_STATE_DIR` pre-seeded with known events: text output contains per-command counts/share, outcome breakdown, duration avg/p50/p95, distinct workspace count, version spread, date range. Integration.
- *`--json`* — `JSON.parse(stdout)` deep-equals `aggregate(seededEvents)`. Integration.
- *Empty log* — missing log → a clean "no events" summary, exit `0`, nothing written to the log. Integration.
- *Does not record itself* — after running `stats`, the log line count is unchanged. Integration.

**Components.**

```ts
// apps/cli/src/commands/stats/render-stats.ts
export function renderStatsText(summary: UsageSummary): string;
export function renderStatsJson(summary: UsageSummary): string; // JSON.stringify(summary, null, 2)

// apps/cli/src/commands/stats/register-stats-command.ts
export function registerStatsCommand(
  program: CommanderCommand,
  context: ProgramContext,
  dependencies: ProgramDependencies,
): void;
```

`stats` registers as a hidden subcommand (commander hidden-subcommand option — confirm exact form for commander v14 during impl) with `--json`. Its action: `resolveStateDir(process.env)` → `usageLogPath` → `new NodeUsageLogReader().read(path)` → `aggregate` → render text/json → `context.stdout.write`. Plain action — does not call `runCommand`, builds no workspace, never invokes `dependencies.recorder`. `renderStatsText` lives in `apps/cli` because `@symnav/renderer` cannot depend on telemetry; it stays out of the six IR renderers.

`program.ts` `buildProgram` calls `registerStatsCommand(program, ctx, deps)` after the four navigation registrations.

**Commit plan.**
1. `test(cli): stats command specs` — integration tests incl. hidden-from-help (red).
2. `feat(cli): add stats summary renderers` — `render-stats.ts` (text + json). Pure formatting.
3. `feat(cli): register hidden stats command` — `register-stats-command.ts` + `program.ts` wiring. Greens stats specs.

**Done when.** `symnav stats` prints text/JSON summaries from the global log, is absent from `--help`, records nothing, handles an empty log. CI green.

---

## Phase 8 — README disclosure and e2e

**Behavior delivered.** End-to-end against the built binary: enabled → one correct line appended; `SYMNAV_TELEMETRY=0` → nothing written; command stdout/stderr/exit identical on vs. off; `stats` reads the log back. README documents what's collected, where, and how to disable.

**Test cases.** (`apps/cli/test/e2e/telemetry/telemetry.test.ts`, built binary, tmp `SYMNAV_STATE_DIR`)
- *Appends one line* — run a real command with telemetry enabled against a fixture → `usage.jsonl` has exactly one line, a valid shape-only event (command, outcome `success`, no symbol names/paths anywhere in the line). E2e.
- *Kill switch writes nothing* — same command with `SYMNAV_TELEMETRY=0` → no `usage.jsonl`, no `.symnav` dir created. E2e.
- *Output identical on vs. off* — stdout, stderr, exit code byte-identical between enabled and disabled runs of the same command. E2e.
- *stats reads back* — after N enabled runs, `symnav stats --json` reports `totalEvents:N`. E2e.
- *Existing e2e unaffected* — current overview/resolve/def/refs/version e2e stay byte-identical (harness defaults telemetry off).

**Components.** `@symnav/testing` `RunSymnavBinaryOptions` gains optional `env`:

```ts
export interface RunSymnavBinaryOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}
```

`runSymnavBinary` merges `{ ...process.env, SYMNAV_TELEMETRY: "0", ...opts.env }` into `spawnSync` — existing e2e (no `env`) run with telemetry off by default; telemetry e2e pass `env: { SYMNAV_TELEMETRY: "1", SYMNAV_STATE_DIR: <tmp> }`. README gains a "Telemetry" section: the event fields collected, `~/.symnav/usage.jsonl` location, and `SYMNAV_TELEMETRY=0` to disable.

**Commit plan.**
1. `test(testing): support env in runSymnavBinary` — extend options + default-off merge, with a small unit covering the merge. (Harness change first so e2e can use it.)
2. `test(cli): telemetry e2e` — `telemetry/telemetry.test.ts` against the built binary.
3. `docs: disclose telemetry in README` — README "Telemetry" section.

**Done when.** Built binary appends one shape-only line when enabled, nothing when `SYMNAV_TELEMETRY=0`; on/off output byte-identical; `stats` reads back the count; README discloses collection + opt-out. Full CI-parity sequence green.

---

## Out of scope

- **Network / upload / transport.** Getting a log to the author is manual export. Future endpoint-based collection; the local schema is the upload schema.
- **Consent UI / runtime notice.** Only README disclosure + `SYMNAV_TELEMETRY=0`.
- **Log rotation or size cap.**
- **`stats` filter flags** (`--since`, `--command`, `--workspace`).
- **Any raw source identifier** — symbol names, file paths, query strings, previews never recorded.
- **Changes to the six commands' observable output** — telemetry is additive and inert to output.
- **Stage 4 (`context`) and Stage 5 (`graph`)** — measured from day one by this seam, but built later.
