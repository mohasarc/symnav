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

- The warning comes after the command's ordinary stderr. Work the daemon already accepted keeps its result or controlled failure; anything not yet submitted runs locally.
- `--no-warnings`: no line, behavior otherwise identical. Works before the command, between arguments, or at the end. A literal `--no-warnings` after `--` or as an option value stays an argument.
- `--help`, `--version`, and read-only commands like `daemon status` don't warn when they need no write.
- `SYMNAV_DAEMON=0` with telemetry on: still warns, telemetry needs the write.
- `SYMNAV_DAEMON=0` and `SYMNAV_TELEMETRY=0`: state location never touched, no warning, no spill files.
- No telemetry or diagnostics are written anywhere else. Command and result spill files stay inside the state location and are removed after delivery.

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

On macOS and Linux daemon ownership needs the standard `mkfifo` executable on `PATH` and a state filesystem that supports FIFOs. PIDs shown by `daemon status` belong to the daemon's own PID namespace, so inside a Linux sandbox they aren't host signal targets. If a sandbox wrapper kills its descendants when the command ends, the next command starts a fresh warm-up; symnav doesn't extend the wrapper's lifetime.

For agents `setup` doesn't know, grant write access to the state location and read access to the workspace by hand. symnav needs no network, TCP, or Unix-socket permission. Policy syntax: [Codex permissions](https://developers.openai.com/codex/permissions), [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing).

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
- Codex: updates legacy `sandbox_workspace_write.writable_roots` or the selected named permission profile. A built-in profile gets a derived profile that inherits its policy and adds only the state path. Never changes the sandbox mode, so read-only sessions still need a write-capable policy. Invalid TOML, conflicting legacy and named selections, and an exact deny of the state path fail without changing the file.
- Claude Code: adds only `sandbox.filesystem.allowWrite`. Keeps sandbox enablement, network settings, deny lists, and permission rules; never enables sandboxing or removes a conflicting deny. Invalid JSON, duplicate keys, and mistyped grant nodes fail without changing the file.
- Restart agent sessions after a change. Project or managed agent policy can still deny the grant.

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

Exit 0 when nothing failed, 1 otherwise. If doctor itself can't write the state location: `symnav: error: cannot write <dir> (<code>)`, exit 1, even with `--no-warnings`.

- No agent argument checks Codex, then Claude Code. Use the same `SYMNAV_STATE_DIR`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` as setup and navigation.
- The live check runs Codex's sandbox command, or Claude Code's standalone sandbox runtime `srt` from `PATH`, with network off. No agent or model session starts.
- Runtime missing: a valid grant gives the configuration-only `ok` above. A missing or denied grant, a policy symnav can't translate, or a runtime that rejects the probe gives `fail`. No agents installed: `skip`, exit 0.
- Probe state is isolated, so doctor works with `SYMNAV_DAEMON=0` and `SYMNAV_TELEMETRY=0`. Status lines stay with `--no-warnings`.
- If doctor can't confirm its own processes exited, it fails and keeps the scratch files instead of deleting live process state.

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

With `SYMNAV_DAEMON=0`: prints `symnav: error: daemon disabled by SYMNAV_DAEMON=0` on stderr, exit 1.

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

Failure reasons: `state write failed`, `endpoint create failed`, `endpoint bind denied`, `endpoint connect failed`, `daemon connection reset`, `process spawn failed`, `startup failed`, `worker failed`, `transfer failed`, `process terminated`, `daemon incompatible`, plus the OS error code when there is one. Older records stay in the diagnostics log. `--json` keeps `schemaVersion: 1` and adds optional `recentFallbacks` and `startupFailures`.

If the state location can't be read, status prints `symnav: error: cannot read daemon status: cannot access <path> (<code>)` and exits 2.

Status removes records of processes confirmed exited. A permission-denied liveness probe isn't proof of exit, and Linux keeps older records whose process identity can't be checked across PID namespaces.

### `daemon stop`

Graceful wait `5 s`, then forced termination. The three outcomes below exit 0. A `Cannot answer:` refusal, such as no Git workspace, exits 1. Any other stop failure prints `symnav: error: cannot stop daemon: <reason>` and exits 2. A filesystem failure names the path and OS code: `cannot access <path> (<code>)`.

```console
$ symnav daemon stop
Stopped daemon for /Users/mo/projects/reelcut (pid 48213)

$ symnav daemon stop
Killed daemon for /Users/mo/projects/reelcut (pid 48213)

$ symnav daemon stop
No daemon running for /Users/mo/projects/reelcut
```

## Diagnostics and telemetry

Diagnostics go to `daemon.log` in the daemon's state directory, never to navigation stdout or stderr. They record startup duration and outcome, queue depth and wait, current command, freshness and navigation duration, response size, memory, and every failure with phase, reason, and OS code. Failure records keep phase, reason, timestamps, workspace, and OS code, and leave out error messages, stacks, source, and environment values. They survive registry cleanup. Rotation limits are in [`daemon-policy.md`](daemon-policy.md).

Telemetry execution mode per command: `warm`, `cold` (local, including during warm-up), or `fallback` (replayed locally after a pre-acceptance daemon failure). Accepted work is recorded once, even if the caller disconnected. To read stats without recording another event: `SYMNAV_DAEMON=1 SYMNAV_TELEMETRY=0 symnav stats --json`. If the usage log can't be read, stats prints `symnav: error: cannot read stats: cannot access <path> (<code>)` and exits 2.

## Performance

Targets after readiness, on a ~4,000-file TypeScript worktree, excluding queue wait:

```text
Targeted overview:        under 500 ms
Resolve and def:          under 2 s
Refs, context, and graph: under 5 s for depth-one queries
```

`pnpm daemon:benchmark --scale <n>` gates `1x`, `2x`, `3x`, and `10x` workspaces on startup time, command time, queue wait, peak memory, response size, parity, freshness, and daemon continuity. A gate fails if the daemon restarts, vanishes from status, emits raw resource failures, or replays accepted work locally.
