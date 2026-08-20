# Symnav Daemon Functional Spec

## Goal

Every symnav command today rebuilds its view of the workspace from scratch: on a 2,000-file TypeScript repo `def` takes ~10s, `refs` ~18s, `context` ~24s, and a target that doesn't exist still costs ~6s. An agent making hundreds of calls per session spends most of the session waiting. This work adds a per-workspace daemon that keeps the workspace loaded between calls so that every command after the first answers in well under a second, while producing exactly the output a cold run would produce. It is transparent: commands, arguments, output, and exit codes do not change. It is not a server for other tools, not a language server, and not a new navigation surface. This spec defines product behavior only and avoids implementation choices.

## Primary User

The first-class user is a coding agent running symnav commands repeatedly inside one long-lived session on a developer's machine — the developer's own project, not a benchmark container. Its default experience: the first command in a workspace pays a cold start; every later command is warm. The agent never starts, stops, or learns about the daemon unless it wants to.

Explicit opt-ins: `symnav daemon start|status|stop` for people who want control; `SYMNAV_DAEMON=0` to force every command to run cold in-process.

## Core Guarantees

### Warm answers equal cold answers

A command answered by the daemon produces the same stdout, stderr, and exit code as the same command run cold against the same workspace state.

```text
For any command, arguments, cwd, and workspace contents:
output(daemon) == output(cold in-process), byte for byte, including exit code.
```

Warnings, errors, `--help`, `--version`, and `--json` are all covered. There is no daemon-only output and no cold-only output.

Consequence for verification: the existing end-to-end suite runs in both modes and must pass unchanged in each.

### Answers reflect the disk at request time

Every request sees the workspace as it is on disk when the request arrives. A file edited, added, deleted, or renamed after the previous request is reflected in the next answer.

```text
A request never answers from workspace state older than the moment the request was received.
```

Example: an agent runs `refs charge`, then renames `charge` to `bill` in one file, then runs `refs charge` again. The second answer does not list the renamed site.

There is no stale-data override. No flag skips the freshness check in exchange for speed.

Known limit of this version: change detection relies on file modification metadata. A write that preserves both modification time and size is not detected. Editors, `git`, and build tools an agent uses do not do this.

### Warm execution never changes correctness

If the daemon cannot be reached, cannot be started, crashes mid-request, or disagrees with the client about its version, the command runs cold in-process and answers normally. The user sees the answer, not the failure.

```text
Daemon unavailability degrades latency, never output or exit code.
```

Example: the daemon is killed while an agent is working. The agent's next command takes cold-start time, prints the normal result, exits 0, and a fresh daemon is available for the command after that.

### One daemon per workspace

A daemon serves exactly one workspace — the directory tree rooted at the nearest `.git` above the command's working directory, the same root every command uses today. Separate repos, git worktrees, and submodules each get their own daemon with its own memory, queue, and lifetime.

```text
Workspace root identity == daemon identity.
```

Working in three repos at once means three daemons. Stopping or crashing one has no effect on the others.

### Requests run one at a time

Within one workspace, requests are answered in arrival order, one at a time. Two commands issued concurrently against the same workspace both complete; the second waits for the first.

```text
Freshness check + answer is atomic per request. No request observes a half-applied change.
```

## Scope

### Included

- Transparent warm execution for every existing command: `overview`, `resolve`, `def`, `refs`, `context`, `graph`, `stats`.
- Automatic daemon start on the first command in a workspace.
- Automatic exit after an idle period.
- `symnav daemon start` — start and warm a workspace's daemon without running a navigation command.
- `symnav daemon status` — report running daemons.
- `symnav daemon stop` — stop a workspace's daemon.
- `SYMNAV_DAEMON=0` — force cold in-process execution.
- Silent in-process fallback on any daemon failure.
- Version mismatch handling after upgrading symnav.
- Freshness based on file modification metadata.
- macOS, Linux, and Windows, with all tests run on Windows in CI.
- Per-daemon log file for diagnosing failures.
- Usage telemetry records whether a command ran warm, cold, or fell back.
- Cold start itself gets faster: the workspace is loaded once per command instead of once per internal stage.

### Excluded

- File-watcher based change detection.
- Content-hash based change detection.
- Cross-workspace or shared daemons.
- Concurrent request execution within one workspace.
- A network-reachable daemon or a protocol for third-party clients.
- Persisting the loaded workspace to disk across daemon restarts.
- Changes to any command's output, arguments, or exit codes.
- Any new navigation capability.
- Daemon behavior for non-TypeScript backends beyond the hook that lets them participate.

## Interaction Model

### Ordinary commands

Unchanged. `symnav refs charge` is typed, behaves, and answers exactly as before. `--cwd <dir>` still selects the workspace; it therefore also selects which daemon answers.

### Daemon commands

```console
$ symnav daemon start
$ symnav daemon status
$ symnav daemon stop
```

`start` and `stop` act on the workspace of the current directory (or `--cwd`). `status` lists every daemon running for the current user, across workspaces. `--json` is accepted by all three.

### Opt-out

```console
$ SYMNAV_DAEMON=0 symnav refs charge
```

Runs cold in-process. No daemon is contacted or started. Output is identical to the warm answer.

### Not accepted

- No flag picks a daemon by name or socket; the workspace root is the only address.
- No flag skips the freshness check.
- No per-command idle-timeout or memory flag; those are daemon defaults.

## Output Format

Navigation command output is unchanged and is the subject of the first core guarantee.

### `daemon start`

```console
$ symnav daemon start
Daemon ready for /Users/mo/projects/reelcut
2142 files loaded in 9.8s
```

When already running:

```console
$ symnav daemon start
Daemon already running for /Users/mo/projects/reelcut (pid 48213, up 14m)
```

### `daemon status`

```console
$ symnav daemon status
/Users/mo/projects/reelcut     pid 48213  up 14m   2142 files  1.3 GB  last request 8s ago
/Users/mo/projects/symnav      pid 48301  up 2m     365 files  310 MB  last request 2m ago
```

No daemons:

```console
$ symnav daemon status
No daemons running.
```

### `daemon stop`

```console
$ symnav daemon stop
Stopped daemon for /Users/mo/projects/reelcut (pid 48213)
```

Not running:

```console
$ symnav daemon stop
No daemon running for /Users/mo/projects/reelcut
```

Exit code 0 in both cases; stopping an absent daemon is not an error.

## Cross-cutting Behavior

### Lifetime

| Event                                     | Behavior                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| First command in a workspace              | Client starts the daemon, waits for it to be ready, sends the request. Command takes cold-start time. |
| Idle                                      | Daemon exits after `30 minutes` without a request.                                                    |
| Two commands start at once with no daemon | Exactly one daemon results; both commands are answered by it.                                         |
| symnav upgraded while a daemon runs       | Next command detects the version mismatch, stops the old daemon, starts a new one, answers.           |
| Daemon crashes                            | Next command falls back in-process, then a fresh daemon starts for the command after.                 |
| Workspace directory deleted               | Daemon exits on its next freshness check or idle timeout.                                             |

### Resource bounds

A daemon's memory is bounded by a fixed cap chosen at start from the machine's RAM. A daemon that exceeds it exits; the client falls back in-process. The cap is not user-configurable in this version.

### Latency targets

Not guarantees — the measuring stick for the work, on a 2,000-file workspace:

```text
Warm def / resolve / overview: under 200 ms end to end.
Warm refs / context / graph:   under 1.5 s end to end.
Cold start:                    at least 2x faster than today.
```

### Determinism

Warm answers are deterministic for the same workspace state and request, exactly as cold answers are.

### Diagnostics

Each daemon writes a log file under the user's symnav state directory, named by workspace. It records start, stop, idle exit, each request's command and duration, freshness results, and failures. Nothing is logged to the user's terminal.

### Telemetry

Each recorded command event carries its execution mode: `warm`, `cold`, or `fallback`. `SYMNAV_TELEMETRY=0` disables telemetry for daemon-answered commands as it does today.

### Platforms

macOS, Linux, Windows. CI runs the full test suite on Linux and Windows, in both cold and warm modes.

## Transparent Warm Execution

**Purpose.** Make the second and later commands in a session fast without the agent doing anything.

**Produces.** The same output as today, sooner.

**Does not produce.** Any visible sign that a daemon was involved — no banner, no hint, no extra stderr line.

Example session on a 2,000-file workspace:

```console
$ symnav def PaymentProcessor::charge        # ~10 s, daemon starts
$ symnav refs PaymentProcessor::charge       # ~0.5 s
$ symnav context PaymentProcessor::charge    # ~1 s
$ symnav def PaymentProcessor::charge        # ~0.1 s
```

**Defaults.** Daemon enabled. Idle exit `30 minutes`.

**Edge cases.**

- Target not found: still answers from the warm workspace, so "not found" is fast too.
- Command usage error (`symnav def` with no target): identical message and exit code to cold mode.
- Workspace is not a git repo: identical error to today; no daemon is started.
- Working directory outside any running daemon's workspace: a new daemon for that workspace.

## `symnav daemon start`

**Purpose.** Warm a workspace ahead of time — before handing a session to an agent, or after a large `git pull`.

**Produces.** Readiness confirmation with file count and load time. Blocks until the daemon can answer.

**Does not produce.** Any navigation output.

**Edge cases.**

- Already running: reports pid and uptime, exit 0.
- Already running but a different symnav version: replaces it, reports as a fresh start.
- `SYMNAV_DAEMON=0` set: prints `Daemon disabled by SYMNAV_DAEMON=0`, exit 1.

## `symnav daemon status`

**Purpose.** See which workspaces have daemons and what they cost.

**Produces.** One line per running daemon: workspace root, pid, uptime, file count, memory, time since last request. Sorted by workspace root.

**Does not produce.** Anything about daemons of other users on the machine.

**Edge cases.**

- A daemon that is starting up shows `starting` in place of file count and memory.
- A stale record of a daemon whose process is gone is cleaned up and not listed.

## `symnav daemon stop`

**Purpose.** Free the memory now rather than after the idle timeout.

**Produces.** Confirmation with pid.

**Does not produce.** An error when nothing is running.

**Edge cases.**

- A request in flight: the daemon finishes answering it, then exits. `stop` returns after exit.
- Daemon does not exit within `5 seconds`: it is killed; `stop` reports `killed` instead of `Stopped`.

## Cold-start Reduction

**Purpose.** The first command in a session — and every command with `SYMNAV_DAEMON=0` — loads the workspace once instead of once per internal stage.

**Produces.** Identical output to today, in roughly half the time on workspaces where `refs` and `context` currently dominate.

**Does not produce.** Any behavior change. This is the part of the work that lands value even if the daemon is disabled.

## Summary

- Every command: warm after the first call in a workspace, same bytes as cold.
- Freshness: every request reflects the disk at request time; no override.
- Fallback: daemon trouble costs time, never correctness.
- Isolation: one daemon per workspace root; one request at a time within it.
- `daemon start`: warm ahead of time.
- `daemon status`: what's running, what it costs.
- `daemon stop`: free it now.
- `SYMNAV_DAEMON=0`: cold, in-process, identical output.
- Platforms: macOS, Linux, Windows, all tested in CI in both modes.
- Cold start itself roughly halves.
