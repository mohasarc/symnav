# Daemon

symnav keeps one background daemon per workspace and state location, so repeated commands answer from warm project state instead of rebuilding it. Ordinary commands never wait for it. They answer locally while the daemon warms, then switch to it once ready. Output is identical either way.

The daemon is not a language server, not a network service, and not a new navigation surface.

Policy values (timeouts, memory limits, retention) live in [`daemon-policy.md`](daemon-policy.md).

## Default experience

```console
$ symnav resolve PaymentProcessor      # local answer; warm-up starts in background
$ symnav overview src/orders.ts        # local answer; same warm-up continues
$ symnav def PaymentProcessor::charge  # answered by the daemon once ready
```

No banner, no progress output, nothing that reveals which route answered.

Knobs:

| Knob                                | Effect                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| `SYMNAV_DAEMON=0`                   | Fully local. No daemon started or contacted               |
| `SYMNAV_TELEMETRY=0`                | No telemetry                                              |
| `SYMNAV_STATE_DIR=<dir>`            | State location other than `~/.symnav`                     |
| `--no-warnings`                     | Drop warning lines from stderr, any command, any position |
| `--cwd <dir>`                       | Selects the workspace, and with it the daemon             |
| `symnav daemon start\|status\|stop` | Explicit lifecycle control                                |

No flag makes a navigation command wait for warm-up. No user-facing knob for timeouts, idle lifetime, or memory limits.

## Guarantees

**Commands never wait for warm-up.** With no ready daemon, the command answers locally while one daemon warms. The route picked when a command is accepted doesn't change mid-command.

**One warm-up per workspace and state location.** Ten cold commands at once: all ten answer locally, one daemon warms. Warm-up continues after the initiating command exits. A twenty-minute warm-up is not discarded for taking long. A warm-up that exits clears its starting state so a later command can retry.

**Same answer on every route.** stdout, stderr and exit code are byte-identical between daemon and local execution, including warnings, `--help`, `--version`, `--json`.

**Answers reflect current workspace state.** Each request sees the workspace as it is when its execution turn begins. For a queued daemon request, that's when it reaches the front of the queue. Added, deleted, and renamed files show up in the next answer.

**Nested Git workspaces are separate.** The workspace is the nearest Git workspace containing the caller. A parent never indexes or returns files from a nested repo, worktree, or submodule, whatever the ignore rules say. Targeting a nested-workspace file from the parent fails with guidance to select it via `--cwd`.

**Slow or busy is not dead.** Only proof of process exit, protocol incompatibility, or corrupt communication invalidates a daemon. A caller timeout or disconnect doesn't remove a live daemon, stop it, or replay accepted work locally. `daemon status` reports a long-running daemon as busy, never absent.

**Resource failures are controlled.** No raw OOM output or partial responses. Capacity limits produce a normal symnav error:

```text
Cannot answer: daemon workspace capacity exceeded.
Cannot answer: daemon response capacity exceeded.
```

Known capacity failures aren't retried through equivalent local execution.

**The daemon needs only the state location.** Read access to the workspace and write access to the state location are enough to start, serve, and reach the daemon. No network permission. Sandboxed and unsandboxed commands against the same workspace and state location share one daemon.

## State location

Default `~/.symnav`. `SYMNAV_STATE_DIR` replaces it. Daemon registry, logs, spools, and endpoints live under `<state>/daemons/<identity>/`:

- macOS and Linux: endpoints are filesystem mailboxes (`<hash>.mailbox`) in that directory. `rm -rf` of the state dir removes everything the daemon created.
- Windows: endpoints are named pipes whose name includes a hash of workspace + state location, so two state locations never collide.

Commands using different state locations never see or disturb each other's daemons.

### Unwritable state location

The state location is the only place symnav writes outside the workspace. When a command needs to write it and can't, it prints one line on stderr, answers locally, and keeps its own exit code:

```console
$ symnav overview src/orders.ts
src/orders.ts
  ...
symnav: warning: cannot write /Users/mo/.symnav (EPERM); daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.
```

- `--no-warnings`: no line, behavior otherwise identical.
- `SYMNAV_DAEMON=0` with telemetry on: still warns, telemetry needs the write.
- `SYMNAV_DAEMON=0` and `SYMNAV_TELEMETRY=0`: state location never touched, no warning.
- No telemetry or diagnostics are written anywhere else.

## Routing

Decided once per command:

| State when accepted  | Behavior                                                |
| -------------------- | ------------------------------------------------------- |
| No daemon            | Trigger one background warm-up, execute locally         |
| Starting             | Execute locally, don't start another                    |
| Ready, idle          | Execute through daemon                                  |
| Ready, busy          | Queue in arrival order (FIFO, one navigation at a time) |
| Dead or incompatible | Clear it, trigger replacement, execute locally          |

Routed commands: `overview`, `resolve`, `def`, `refs`, `context`, `graph`, `stats`. Lifecycle requests stay responsive while navigation runs.

## Lifetime

- Idle exit after `30 minutes` without a navigation request. The clock resets when a navigation request is accepted.
- Workspace deletion, `daemon stop`, version mismatch, or resource-driven shutdown end it sooner.
- Caller lifetimes don't control daemon lifetime.
- Under memory pressure the daemon replaces its navigation worker. A replacement overlapping the end of warm-up never fails startup.

## Agent sandboxes

Coding agents run symnav inside OS sandboxes that deny network and restrict writes. The daemon works there as long as the sandbox grants write access to the state location. Without the grant, every command runs cold and prints the warning above.

### `symnav setup <agent>`

Adds the state location to the agent's user-level sandbox write grants. Agents: `codex` (`~/.codex/config.toml`, or `$CODEX_HOME`), `claude-code` (`sandbox.filesystem.allowWrite` in `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR`).

```console
$ symnav setup codex
Granted write access to /Users/mo/.symnav in /Users/mo/.codex/config.toml
Restart Codex sessions to apply.

$ symnav setup claude-code
Claude Code already grants write access to /Users/mo/.symnav (/Users/mo/.claude/settings.json)

$ symnav setup codex
symnav: error: cannot update /Users/mo/.codex/config.toml: invalid TOML at line 12
```

- Exactly one agent argument. Unknown agent is rejected.
- Idempotent. Preserves other config content. Creates the file if missing. Invalid config: exit 1, file untouched.
- Agent not on PATH: grant still written, plus `Codex was not found on PATH; the grant applies when installed.`
- Never enables network, grants other paths, or touches project-level agent config.
- Uses the state location in effect, so set `SYMNAV_STATE_DIR` when running it if you use a custom one.

### `symnav doctor [agent]`

Runs a probe inside each installed agent's sandbox against a scratch workspace and checks the command is answered warm and recorded in telemetry. Leaves no daemon or scratch files behind and changes no config.

```console
$ symnav doctor
codex        ok    daemon warm inside sandbox, telemetry recorded
claude-code  fail  sandbox denies write to /Users/mo/.symnav; run 'symnav setup claude-code'
```

```console
claude-code  ok    configuration grants /Users/mo/.symnav; live sandbox check skipped: sandbox runtime not found
codex        skip  not installed
```

Exit 0 when nothing failed, 1 otherwise. If doctor itself can't write the state location: `symnav: error: cannot write <dir> (<code>)`, exit 1.

### Platforms

Sandbox support covers macOS and Linux. Windows gets the warning and `--no-warnings`; daemon reachability there is unchanged.

## Lifecycle commands

All three act on the workspace from cwd or `--cwd` and accept `--json`.

### `daemon start`

Waits until ready or a confirmed startup failure. No timeout on a healthy warm-up, no progress output.

```console
$ symnav daemon start
Daemon ready for /Users/mo/projects/reelcut
2142 files loaded in 9.8s

$ symnav daemon start
Daemon already running for /Users/mo/projects/reelcut (pid 48213, up 14m)
```

With `SYMNAV_DAEMON=0`: prints `Daemon disabled by SYMNAV_DAEMON=0` on stderr, exit 1.

### `daemon status`

Lists daemons for the current user and state location, sorted by workspace path. Target response time `1 second`. Never starts, waits on, or invalidates a daemon.

```console
$ symnav daemon status
/Users/mo/projects/reelcut  pid 48213  up 14m  ready  2142 files  1.3 GB  last request 8s ago
/Users/mo/projects/large-workspace  pid 48301  starting 12m  2.1 GB
/Users/mo/projects/api  pid 48390  up 2h  busy refs  43s  queued 2  1.6 GB
```

Other states: `unresponsive` (live but not answering) and `recovering <detail>`. `no requests` replaces `last request …` on a fresh daemon.

Failures from the last hour, shown only when present:

```console
/Users/mo/projects/reelcut  pid 48213  up 14m  ready  2142 files  1.3 GB  last request 8s ago
  3 fallbacks in last hour: daemon connection reset (ECONNRESET)

$ symnav daemon status
No daemons running.
/Users/mo/projects/reelcut  last startup failed 2m ago: endpoint bind denied (EPERM)
```

Failure reasons: `state write failed`, `endpoint create failed`, `endpoint bind denied`, `endpoint connect failed`, `daemon connection reset`, `process spawn failed`, `startup failed`, `worker failed`, `transfer failed`, `process terminated`, `daemon incompatible`, plus the OS error code when there is one. Older records stay in the diagnostics log.

### `daemon stop`

Graceful wait `5 s`, then forced termination. All cases exit 0.

```console
$ symnav daemon stop
Stopped daemon for /Users/mo/projects/reelcut (pid 48213)

$ symnav daemon stop
Killed daemon for /Users/mo/projects/reelcut (pid 48213)

$ symnav daemon stop
No daemon running for /Users/mo/projects/reelcut
```

## Diagnostics and telemetry

Diagnostics go to `daemon.log` in the daemon's state directory, never to navigation stdout or stderr. They record startup duration and outcome, queue depth and wait, current command, freshness and navigation duration, response size, memory, and every failure with phase, reason, and OS code.

Telemetry execution mode per command: `warm`, `cold` (local, including during warm-up), or `fallback` (replayed locally after a pre-acceptance daemon failure). Accepted work is recorded once, even if the caller disconnected.

## Performance

Targets after readiness, on a ~4,000-file TypeScript worktree, excluding queue wait:

```text
Targeted overview:        under 500 ms
Resolve and def:          under 2 s
Refs, context, and graph: under 5 s for depth-one queries
```

`pnpm daemon:benchmark --scale <n>` gates `1x`, `2x`, `3x`, and `10x` workspaces on startup time, command time, queue wait, peak memory, response size, parity, freshness, and daemon continuity. A gate fails if the daemon restarts, vanishes from status, emits raw resource failures, or replays accepted work locally.

## Out of scope

- Concurrent navigation inside one daemon.
- Sharing project state across workspaces.
- Network-reachable daemon, third-party protocol, transport options, or network fallback.
- Persisting loaded state across daemon restarts.
- User knobs for timeouts, idle lifetime, or memory limits.
- Running under sandboxes that deny writes to the state location (e.g. Codex `read-only`).
- Writing state into the workspace.
