# Symnav Daemon Functional Spec

## Goal

Symnav keeps a reusable workspace daemon so repeated navigation commands avoid rebuilding the same project state. Ordinary commands never wait for daemon startup: they answer locally while one daemon warms in the background, then later commands switch to the ready daemon. This must remain useful on representative workspaces and on projects up to ten times larger. The daemon is not a language server, a network service, or a new navigation surface. This spec defines product behavior only and avoids implementation choices.

## Primary User

The first-class user is a coding agent issuing many symnav commands during a long development session.

Its default experience is:

- First command starts one background warm-up and answers locally.
- Further commands answer locally while warm-up continues.
- Commands use the daemon after it becomes ready.
- No navigation output reveals which route answered it.

Explicit alternatives are `symnav daemon start|status|stop` for lifecycle control and `SYMNAV_DAEMON=0` for fully local execution.

## Core Guarantees

### Ordinary commands never wait for warm-up

An ordinary command starts local execution without waiting for a daemon to become ready.

```text
If no ready daemon exists when a command is accepted, that command answers locally while one daemon warms independently.
```

The route chosen when a command is accepted does not change midway through that command. A daemon becoming ready does not cancel or duplicate local work already in progress.

Examples:

- First `resolve` in a large workspace starts warm-up and runs locally at once.
- A second `overview` issued ten minutes into a twenty-minute warm-up also runs locally at once.
- First command after readiness uses the daemon.
- A warm-up failure does not delay or alter local command output.

There is no flag that makes ordinary navigation commands wait for warm-up.

### One durable warm-up per workspace

Concurrent callers share one warm-up. Initiating caller does not own daemon lifetime.

```text
For one workspace and state location, at most one daemon is starting or ready, regardless of caller count or caller lifetime.
```

The daemon continues warming after initiating command exits. Later callers observe or adopt that warm-up; they do not restart it. A caller failure, timeout, or disconnect cannot stop a healthy warm-up.

Examples:

- Ten commands begin together in a cold workspace. All ten answer locally and exactly one daemon warms.
- Initiating process exits one second after launch. Warm-up continues to readiness.
- A healthy warm-up takes twenty minutes. It is not discarded because of project size or elapsed time.
- Warm-up process exits. Starting state is cleared promptly and a later eligible command may try again.

There is no healthy-startup timeout override because healthy automatic warm-up has no project-size deadline.

### Warm answers equal local answers

A command answered by the daemon produces the same stdout, stderr, and exit code as the same command run locally against the same workspace state.

```text
For any command, arguments, cwd, and workspace contents:
output(daemon) == output(local), byte for byte, including exit code.
```

Warnings, errors, `--help`, `--version`, and `--json` are covered. There is no daemon-only navigation output and no local-only navigation output.

There is no parity override.

### Answers reflect current workspace state

Every request sees workspace contents current when its execution turn begins.

```text
A request never answers from workspace state older than start of its execution turn.
```

For local commands, execution turn begins when local execution starts. For queued daemon commands, it begins when command reaches front of queue.

Examples:

- A file edited after one request is reflected in next request.
- A queued request sees edits completed before its queue turn begins.
- Added, deleted, and renamed files appear in next answer.

There is no stale-data override.

### Nested Git workspaces are separate boundaries

Selected workspace is nearest Git workspace containing caller. A descendant directory with its own Git workspace marker belongs to a separate workspace.

```text
Parent commands never traverse, index, refresh, or return files from a nested repository, worktree, or submodule.
```

This boundary is independent of ignore rules. Ignore negation cannot pull a nested workspace back into its parent.

Examples:

- A parent repository containing `.worktrees/feature` does not return symbols from that worktree.
- Running with `--cwd .worktrees/feature` selects and navigates worktree normally.
- Directly targeting a nested-workspace file from its parent fails with guidance to select nested workspace.
- A directory named `.worktrees` with no nested Git workspace remains ordinary workspace content.

There is no include-nested-workspaces override.

### Slow or busy does not mean dead

Long startup, queue wait, and command execution are not daemon failures.

```text
Only authenticated evidence of process exit, protocol incompatibility, or corrupt communication invalidates daemon ownership.
```

A caller timeout or disconnect does not remove a live daemon record, stop a healthy daemon, or replay accepted work locally. A short command queued behind long work cannot destroy daemon state.

Lifecycle status remains responsive while navigation work is running and reports daemon as busy rather than absent.

There is no force-invalidate-on-timeout override.

### Resource failures are controlled

Supported workloads do not end with raw out-of-memory output, partial responses, or an unreported daemon disappearance.

```text
A resource or response-size limit produces either a complete normal answer or a complete symnav error while preserving recoverable daemon state.
```

Known capacity failures are not immediately repeated through equivalent local execution. A large response does not by itself mark daemon corrupt.

There is no raw-failure override.

## Scope

### Included

- Background warm-up for `overview`, `resolve`, `def`, `refs`, `context`, `graph`, and `stats`.
- Local answers during warm-up.
- One durable starting or ready daemon per workspace and state location.
- Startup that may take at least twenty minutes without a healthy-startup deadline.
- Warm execution with byte-for-byte local parity.
- Current-state refresh before each command's execution turn.
- Nested repository, worktree, and submodule boundaries.
- FIFO navigation execution within one ready workspace daemon.
- Responsive lifecycle control during navigation work.
- Controlled handling of long commands, caller disconnects, resource pressure, and large responses.
- Explicit `daemon start`, `daemon status`, and `daemon stop`.
- `SYMNAV_DAEMON=0` local-only execution.
- State-location isolation through `SYMNAV_STATE_DIR`.
- Version mismatch replacement.
- Diagnostic logs and execution-mode telemetry.
- Gating performance and resource measurements on realistic and scaled workspaces.

### Excluded

- Concurrent navigation execution within one workspace daemon.
- Cross-workspace shared project state.
- Traversing nested Git workspaces from a parent command.
- A network-reachable daemon or third-party protocol.
- Persisting a loaded workspace across daemon restarts.
- A user flag for startup timeout, request timeout, idle timeout, or memory limit.
- New navigation commands or changes to navigation result grammar.
- File-watcher configuration exposed to users.
- Support for non-TypeScript language backends beyond existing participation contract.

## Interaction Model

### Ordinary commands

Existing invocations are unchanged:

```console
$ symnav resolve PaymentProcessor
$ symnav overview src/checkout/CheckoutService.ts
$ symnav refs CheckoutService::processPayment
```

`--cwd <dir>` selects both workspace and daemon. A command never accepts a daemon name, process identifier, endpoint, or nested-workspace inclusion flag.

### Daemon commands

```console
$ symnav daemon start
$ symnav daemon status
$ symnav daemon stop
```

`start` and `stop` act on workspace selected by current directory or `--cwd`. `status` lists validated daemon state for current user and configured state location. All three accept `--json`.

### Local-only execution

```console
$ SYMNAV_DAEMON=0 symnav refs CheckoutService::processPayment
```

No daemon is contacted or started. Output remains equivalent to warm execution.

### State-location isolation

```console
$ SYMNAV_STATE_DIR=/tmp/session-a symnav resolve PaymentProcessor
```

Registry, logs, endpoints, and daemon ownership are isolated from clients using another state location. Separate state locations do not collide or invalidate each other's daemons.

## Output Format

Navigation output is unchanged.

### `daemon start`

Ready:

```console
$ symnav daemon start
Daemon ready for /Users/mo/projects/reelcut
2142 files loaded in 9.8s
```

Already running:

```console
$ symnav daemon start
Daemon already running for /Users/mo/projects/reelcut (pid 48213, up 14m)
```

An explicit start waits until readiness or a confirmed startup failure. A healthy twenty-minute startup remains attached and produces no progress bytes before its final response.

### `daemon status`

Ready daemons:

```console
$ symnav daemon status
/Users/mo/projects/reelcut  pid 48213  ready  up 14m  2142 files  1.3 GB  last request 8s ago
```

Starting or busy daemons:

```console
$ symnav daemon status
/Users/mo/projects/large-workspace  pid 48301  starting  12m  memory 2.1 GB
/Users/mo/projects/reelcut  pid 48213  busy refs  43s  queued 2  memory 1.6 GB
```

No daemons:

```console
$ symnav daemon status
No daemons running.
```

Status never reports a live busy daemon as absent merely because its current command is slow.

### `daemon stop`

```console
$ symnav daemon stop
Stopped daemon for /Users/mo/projects/reelcut (pid 48213)
```

When absent:

```console
$ symnav daemon stop
No daemon running for /Users/mo/projects/reelcut
```

Both cases exit `0`.

### Controlled capacity failure

```text
Cannot answer: workspace operation exceeded available resources.
```

Error is complete, uses normal symnav error output, and does not include a runtime crash dump.

## Cross-cutting Concerns

### Routing and queueing

Routing is decided once per command:

| State when command is accepted | Behavior                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| No daemon                      | Trigger one background warm-up and execute locally            |
| Starting                       | Execute locally without waiting or starting another daemon    |
| Ready and idle                 | Execute through daemon                                        |
| Ready and busy                 | Queue through daemon in arrival order                         |
| Confirmed dead or incompatible | Clear invalid ownership, trigger replacement, execute locally |

Lifecycle requests remain independent of navigation queue responsiveness.

### Lifetime

- Idle exit: `30 minutes` after last completed navigation request.
- Warm-up time does not count as idle time.
- Navigation activity resets idle period.
- Workspace deletion, explicit stop, confirmed incompatibility, or controlled resource shutdown may end daemon sooner.
- Initiating and waiting caller lifetimes do not control daemon lifetime.

### Performance targets

Targets are measured end to end on a representative worktree of about 4,000 TypeScript files after daemon readiness:

```text
Targeted overview:        under 500 ms
Resolve and def:          under 2 s
Refs, context, and graph: under 5 s for representative depth-one queries
```

Warm no-change performance is measured repeatedly, not from one best run. Targets include freshness, command work, rendering, and transport, but exclude queue wait.

Scale gates cover realistic workspaces at `1x`, `2x`, `3x`, and `10x` reference-workspace size. Every gate records startup duration, command duration, queue wait, peak memory, response size, result parity, freshness after changes, and daemon continuity.

A scale gate may take longer as project size grows. Representative commands at every scale complete under default resource policy. A gate does not pass if daemon restarts, disappears from status, emits raw resource failures, or retries accepted work locally.

### Diagnostics

Daemon diagnostics record:

- Startup duration and outcome.
- Queue depth and queue-wait duration.
- Current command and elapsed time.
- Workspace discovery and freshness duration.
- Navigation and rendering duration.
- Response size.
- Current and peak memory.
- Controlled shutdown and confirmed crash reason.

Diagnostics never appear in navigation stdout or stderr.

### Telemetry

Execution mode remains `warm`, `cold`, or `fallback`.

- Local commands during healthy warm-up are `cold`.
- Commands replayed locally after a pre-acceptance daemon failure are `fallback`.
- A command accepted by daemon is recorded once and is not also recorded as fallback because caller disconnected.
- `SYMNAV_TELEMETRY=0` disables telemetry in every mode.

### Platforms

Behavior applies on macOS, Linux, and Windows. Warm and local parity runs on supported CI platforms.

## Transparent Background Warm-up

**Purpose.** Build reusable project state without making ordinary commands wait.

**Produces.** One local answer per command until daemon is ready, then warm answers.

**Does not produce.** Startup banners, progress output, duplicate daemons, duplicate command answers, or partial output.

Example:

```console
$ symnav resolve PaymentProcessor      # local answer; warm-up starts
$ symnav overview src/orders.ts        # local answer; same warm-up continues
$ symnav def PaymentProcessor::charge  # warm answer after daemon becomes ready
```

**Defaults.** Enabled.

**Edge cases.** Concurrent first calls elect one warm-up. Caller exit does not cancel it. Confirmed startup failure clears starting state so a future call may retry.

## Explicit Daemon Start

**Purpose.** Wait for a workspace to become warm before beginning a navigation session.

**Produces.** One readiness or already-running response.

**Does not produce.** Navigation output or a healthy-startup timeout.

**Edge cases.** Concurrent explicit starts wait for same daemon. A child failure returns promptly. `SYMNAV_DAEMON=0` prints `Daemon disabled by SYMNAV_DAEMON=0` and exits `1`.

## Daemon Status

**Purpose.** Show starting, ready, busy, and queued work without disturbing it.

**Produces.** Workspace, state, process identifier, uptime or startup elapsed time, file count when known, memory, current command when busy, queue depth, and last-request age.

**Does not produce.** False absence because a command blocks navigation work, records from another state location, or data about another user.

**Defaults.** Workspace-path sort order. Status response target: `1 second`.

**Edge cases.** Confirmed stale records are removed. An unresponsive but live process is reported as unresponsive, not silently omitted. Status never invalidates a daemon.

## Daemon Stop

**Purpose.** End background work and release memory explicitly.

**Produces.** Stopped, killed, or absent confirmation.

**Does not produce.** An error for an absent daemon.

**Defaults.** Graceful wait: `5 seconds`, then controlled termination.

**Edge cases.** An in-flight request may complete during graceful wait. Forced stop produces one complete outcome for its connected caller and removes daemon ownership after process exit.

## Warm Navigation

**Purpose.** Reuse loaded workspace state for repeated commands.

**Produces.** Current, byte-equivalent navigation answers within scale targets.

**Does not produce.** Results from nested workspaces, stale results, raw resource failures, or full repeated local work after caller timeout.

**Edge cases.** Long results transfer completely or fail with a controlled result-size error without invalidating daemon. Package aliases and workspace imports resolve with same correctness as local project execution. Empty reference, context, or graph results mean there are no results, not that workspace imports were skipped.

## Summary

- Ordinary commands answer locally while one daemon warms independently.
- Healthy warm-up may take twenty minutes or more without being discarded.
- Exactly one daemon starts per workspace and state location.
- Ready commands are current and byte-equivalent to local execution.
- Nested Git workspaces never leak into parent results.
- Slow, queued, and disconnected callers do not invalidate healthy daemon state.
- Status stays truthful and responsive during long work.
- Resource and response-size failures are controlled and never blindly replayed.
- Realistic 1x, 2x, 3x, and 10x reference-workspace gates cover latency, memory, parity, freshness, and continuity.
