# Symnav Daemon Follow-ups Functional Spec

## Goal

Eight behavior changes surfaced by the architecture reviews and deferred until after the daemon restructuring in `daemon-architecture-functional-spec.md`. Each amends `daemon-functional-spec.md`; that document stays the source of truth for everything not named here. This is not a rewrite of routing, admission, or delivery, and not a change to any navigation command's output. This spec defines product behavior only; implementation choices live in the phased plans.

## Primary User

Same as `daemon-functional-spec.md`: an AI coding agent issuing `symnav` commands, plus the human running `daemon start|status|stop`. Default experience is unchanged; seven items change daemon behavior and one evaluates a simpler election mechanism.

## Core Guarantees

All guarantees in `daemon-functional-spec.md` hold. Two are sharpened.

### Slow is not dead, but silent forever is abandoned

A daemon warming up for hours stays valid as long as it keeps reporting progress. A daemon that stops reporting progress while its process stays alive is eventually treated as abandoned.

```text
A starting daemon that has reported no progress for the startup silence bound is abandoned:
its ownership is cleared and the next eligible command may trigger a replacement.
```

This is a bound on silence, not on warm-up duration. A healthy twenty-minute or two-hour warm-up that keeps reporting progress is never abandoned. There is still no healthy-startup timeout.

### Bounded memory for accepted work

Every structure that records accepted requests is bounded. A daemon serving requests for days does not grow because of its own bookkeeping.

```text
Once a result is acknowledged, or its retention period ends, nothing about that request remains in daemon memory.
```

There is no unbounded-retention override.

## Scope

### Included

- Accepted-request ledger eviction.
- Startup silence bound.
- `daemon start` readiness proved on the control plane.
- Endpoints under the state directory.
- Selection-aware source-cache retention.
- Readiness-armed idle lifetime.
- Completion-based idle lifetime.
- Election by socket bind (evaluation; adopted only if it passes the existing daemon suites).

### Excluded

- Any change to navigation command output or exit codes.
- New flags or environment variables. The silence bound and retention period are policy values with no user tuning.
- Changing the `30 minutes` idle exit, routing table, or FIFO execution.
- Changing `daemon status` line format beyond what a state change already produces.

## Interaction Model

Unchanged. `symnav <command>`, `symnav daemon start|status|stop`, `--cwd`, `SYMNAV_DAEMON=0`, `SYMNAV_STATE_DIR` behave as specified in `daemon-functional-spec.md`.

## Output Format

Unchanged. `daemon start`, `daemon status`, and `daemon stop` print the same lines. The only observable differences are _when_ `daemon start` returns and _which_ state `daemon status` reports for an abandoned startup.

## Cross-cutting Concerns

### Policy values

| Value                      | Default     | Reason                                                                                                      |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| Startup silence bound      | `6 hours`   | Longer than any observed healthy warm-up gap; short enough that a hung daemon recovers within a working day |
| Acknowledged-entry removal | immediate   | Nothing references an acknowledged result                                                                   |
| Unacknowledged retention   | `5 minutes` | Matches operation-trace retention so reconnect evidence and ledger expire together                          |

Values live in the daemon policy record; tests override them, users cannot.

### Ordering

Endpoint relocation and the election evaluation change how a daemon is found and owned; they land after ledger eviction, the silence bound, and control-plane readiness, which do not.

## Ledger Eviction

**Purpose.** Stop the accepted-request ledger growing for the daemon's lifetime.

**Produces.** An acknowledged request disappears from the ledger at acknowledgement. An accepted request whose client never acknowledges disappears when its operation trace expires. Memory reported by `daemon status` stays flat under sustained request churn with no workspace changes.

**Does not produce.** Early removal of a request whose result has not been delivered. A duplicate execution: a reconnect inside the retention period still attaches to the existing result.

**Examples.**

- 10,000 `overview` requests over a day, all acknowledged: ledger holds zero entries afterwards.
- A client disconnects after acceptance and never returns: entry and spool are gone `5 minutes` after completion.
- A client reconnects `4 minutes` after disconnect: it receives the stored result; at `6 minutes` it receives a not-found rejection and executes locally, since admission was never proven for that reconnect.

**Edge cases.** Retention is measured from completion, not acceptance. A request still queued or executing is never evicted.

## Startup Silence Bound

**Purpose.** Recover from a warm-up that hangs without crashing.

**Produces.** A daemon in `starting` that has reported no progress for `6 hours` is abandoned: its record is cleared, `daemon status` no longer lists it, and the next ordinary command triggers a new warm-up. The abandoned process is terminated the same way `daemon stop` terminates a daemon.

**Does not produce.** Abandonment of a starting daemon that keeps reporting progress, however long it takes. Any change to ordinary-command latency: commands keep answering locally while a daemon is starting or abandoned.

**Examples.**

- Warm-up of a 10× workspace takes `2 hours` with steady progress: never abandoned; `daemon status` shows `starting 2h`.
- Warm-up deadlocks after `3 minutes`; process stays alive: for `6 hours` `daemon status` shows `starting`; afterwards the record is gone and the next command starts a replacement.
- Explicit `daemon start` attached to a warm-up that is then abandoned: returns a startup failure, exit `1`, naming the silence bound.

**Edge cases.** Machine sleep pauses the clock the bound is measured on; wall-clock jumps do not abandon a daemon. Concurrent commands observing an abandoned record trigger exactly one replacement.

## Control-Plane Readiness

**Purpose.** Make `daemon start` return as soon as the daemon can accept work, independent of queued navigation.

**Produces.** `daemon start` reports ready when the daemon's worker is initialized and admission is open. On an already-ready busy daemon it returns `already running` at once.

**Does not produce.** A wait behind queued or executing navigation requests. A readiness claim for a daemon whose worker has not finished initializing.

**Examples.**

- Daemon ready, currently executing a `40 s` `refs`: `daemon start` returns `already running` within the status response target of `1 second`.
- Daemon starting, `4 minutes` remaining: `daemon start` waits `4 minutes`, then prints `ready`, without any navigation request having run.

**Edge cases.** A daemon that becomes ready and then fails its worker before `daemon start` returns reports a startup failure, not ready. Concurrent explicit starts all return when the same daemon becomes ready.

## Endpoints Under the State Directory

**Purpose.** Make a state location fully self-contained.

**Produces.** The daemon's local endpoint lives under the state directory alongside registry, logs, and spools. Removing a state directory removes everything belonging to its daemons; a daemon whose state directory is removed while running shuts down as it does today on workspace deletion.

**Does not produce.** Cross-user endpoint visibility: permissions on the state directory continue to isolate users. Any change to `SYMNAV_STATE_DIR` semantics.

**Examples.**

- `SYMNAV_STATE_DIR=/tmp/session-a symnav daemon start`, then `rm -rf /tmp/session-a`: no socket or pipe remains anywhere on the machine.
- Two state locations for the same workspace: two endpoints, in two directories, never colliding.

**Edge cases.** Platforms with a path-length limit on endpoints fall back to a short endpoint name derived from the state directory identity, still under that directory where the platform allows a filesystem endpoint at all. On platforms where endpoints are not filesystem objects, the endpoint name incorporates the state directory identity so removal semantics hold by construction.

## Election by Socket Bind

**Purpose.** Evaluate replacing the file-lease election with the operating system's rule that one process can own an endpoint.

**Produces.** An evaluation with the existing e2e daemon and parity suites as the oracle. If adopted: a daemon binds its endpoint as its first act; concurrent starters spawn children that lose the bind and exit before loading any workspace state; a client that finds a dead endpoint clears it and triggers a replacement; the registry records only where a daemon is, not who is allowed to start one. Every guarantee in `daemon-functional-spec.md` still holds, including one durable warm-up per workspace and slow-is-not-dead.

**Does not produce.** A behavior difference visible in any spec example. More than one ready daemon per workspace and state location at any moment.

**Examples.**

- Ten cold commands at once: up to ten short-lived processes start, one binds and warms, nine exit within the startup budget; all ten commands answer locally. `daemon status` shows one daemon.
- Daemon crashes leaving a stale endpoint: next command finds it unreachable, clears it, triggers one warm-up, answers locally.

**Edge cases.** Two clients clearing the same stale endpoint at once still yield one bound daemon. A daemon that binds and then fails during warm-up releases the endpoint on exit so the next command can retry.

**Outcome.** If the evaluation fails a suite or violates a guarantee, the file lease stays and this section is withdrawn.

## Selection-Aware Source-Cache Retention

**Purpose.** Avoid discarding unchanged sibling source bytes when a retained command refreshes only its selected file.

**Produces.** A selection refresh updates cached revisions for supplied files without evicting omitted files from the last authoritative workspace refresh. A later workspace refresh still replaces the authoritative revision set, invalidates changed bytes, and removes deleted files before a whole-workspace semantic query runs.

**Does not produce.** Eager metadata or source reads for omitted siblings during a selection command. A stale navigation answer. Cache ownership of workspace discovery or project membership.

**Examples.**

- A full refresh caches `src/a.ts` and `src/b.ts`; an `overview src/a.ts` selection retains cached bytes for `src/b.ts` without statting or reading it.
- A later `refs` turn finds `src/b.ts` unchanged during its workspace refresh and reuses the retained bytes.
- A later workspace refresh finds `src/b.ts` changed or deleted and invalidates its old bytes before navigation starts.

**Edge cases.** A selection with a changed absolute path or change token invalidates the prior bytes for that supplied file. Omitted entries remain bounded by the most recent authoritative workspace snapshot.

## Readiness-Armed Idle Lifetime

**Purpose.** Give every ready daemon the full idle interval before automatic shutdown.

**Produces.** Idle accounting starts when worker initialization, warm resource sampling, and ready-record publication finish. Startup time does not consume the ready daemon's idle interval.

**Does not produce.** A change to the idle interval or any earlier readiness publication.

**Example.** A daemon that spends longer than the idle interval warming remains available for the full idle interval after it publishes ready instead of shutting down immediately.

## Completion-Based Idle Lifetime

**Purpose.** Measure idle time from the end of the latest navigation turn.

**Produces.** Completing a navigation turn starts a fresh idle interval. A request that runs longer than the idle interval does not trigger immediate idle shutdown when its queue becomes idle.

**Does not produce.** A reset for control-plane requests or non-navigation activity.

**Example.** A navigation accepted just before its deadline and running for ten minutes remains ready for the full idle interval after completion.

## Summary

| Change                         | One line                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Ledger eviction                | Acknowledged entries removed at once; unacknowledged expire with their trace        |
| Startup silence bound          | A starting daemon silent for `6 hours` is abandoned and replaced                    |
| Control-plane readiness        | `daemon start` returns when admission opens, not after queued navigation            |
| Endpoints under state dir      | Removing a state directory removes its endpoints                                    |
| Selection-aware source cache   | Selection refreshes retain unchanged omitted bytes without eager sibling reads      |
| Readiness-armed idle lifetime  | Idle accounting starts only after readiness publication                             |
| Completion-based idle lifetime | Navigation completion starts a fresh idle interval                                  |
| Election by socket bind        | Evaluate OS-enforced single owner in place of file lease; adopt only if suites pass |
