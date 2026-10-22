# Symnav Daemon Under Agent Sandboxes Functional Spec

## Goal

Symnav keeps one background daemon per workspace so repeated navigation commands are answered from warm project state instead of rebuilding it. Coding agents run symnav inside OS sandboxes that deny network access and restrict writes. Under those sandboxes today the daemon never starts and is never reached: every command silently runs cold, and no telemetry is recorded. This spec makes the daemon start and answer inside agent sandboxes that grant write access to the symnav state location, gives a one-command way to grant it for Codex and Claude Code, gives a command that proves it works, makes an ungranted state location visible, and makes daemon failures explainable. It is not a sandbox escape and does not ask agents for network access. This spec defines product behavior only and avoids implementation choices.

## Primary User

The first-class user is a coding agent issuing many symnav commands during a session, usually inside the agent's sandbox. The second user is the human who installs symnav, configures agents, and inspects daemons.

Default agent experience after `symnav setup <agent>`:

- First command in a workspace starts one background warm-up and answers locally without waiting.
- Further commands answer locally while warm-up continues.
- Commands are answered by the daemon once it is ready.
- Every command is recorded in telemetry.
- Nothing extra appears on stdout or stderr, and no output reveals which route answered.

Explicit alternatives:

- `SYMNAV_DAEMON=0` — fully local; no daemon started or contacted.
- `SYMNAV_TELEMETRY=0` — no telemetry.
- `SYMNAV_STATE_DIR=<dir>` — state location other than `~/.symnav`.
- `--no-warnings` — no warning lines on stderr.
- `symnav daemon start|status|stop` — explicit lifecycle control.

## Core Guarantees

### The daemon needs only the state location

Reading the workspace and writing the state location is enough for the daemon to start, serve, and be reached. No network permission and no other writable location are required.

```text
If a command can write the state location, it can start the workspace daemon and use it once ready,
whether or not the command runs inside an agent sandbox.
```

A command inside a sandbox and a command outside it, against the same workspace and state location, share one daemon. Neither starts a second one. Removing the state location removes everything the daemon created for it.

There is no transport option and no network fallback.

### State writes are required

The state location is the only place symnav writes outside the workspace. Every write symnav needs there either succeeds or is reported.

```text
When a command needs to write the state location and cannot, it prints one warning on stderr
and answers locally. It never silently skips telemetry or daemon startup.
```

A command that needs no state writes produces no warning. With `SYMNAV_DAEMON=0` and `SYMNAV_TELEMETRY=0` together, symnav does not touch the state location.

There is no unrecorded mode other than `SYMNAV_TELEMETRY=0`.

### Same answer on every route

A command answered by the daemon produces the same stdout, stderr, and exit code as the same command answered locally against the same workspace state. Warnings and `--no-warnings` behave identically on both routes.

### Daemon failures are explained where a human looks

A daemon that fails to start or stops unexpectedly, and a command that falls back to local execution after a daemon failure, record a named reason with the operating-system error code when one exists. `symnav daemon status` shows them. Navigation stdout and stderr never do.

```text
Daemon failure reasons appear in daemon status and diagnostics, never in navigation output.
The only daemon-related stderr line in navigation output is the unwritable-state-location warning.
```

A daemon process never ends without a recorded reason.

### Warm-up ends in ready or in a recorded failure

A warm-up that is progressing always ends in ready or in a recorded startup failure. Work the daemon does to stay within its memory limits while warming, including replacing its navigation worker, never by itself fails startup, whichever finishes first.

## Scope

### Included

- Daemon start and reachability inside sandboxes that grant write to the state location.
- One daemon shared by sandboxed and unsandboxed commands for the same workspace and state location.
- Daemon-created files and endpoints contained in the state location.
- Unwritable-state-location warning on stderr.
- `--no-warnings` on every command.
- `symnav setup codex` and `symnav setup claude-code`.
- `symnav doctor`.
- Named failure reasons with OS error codes in diagnostics and `daemon status`.
- Recent fallbacks and last startup failure in `daemon status`.
- Warm-up completion when a worker replacement overlaps the end of warm-up.
- End-to-end coverage of `daemon status` and `daemon stop` against the built binary.

### Excluded

- Running the daemon in a sandbox that denies writes to the state location, including Codex `read-only` mode.
- Writing state into the workspace.
- Asking agents to enable network access.
- `setup` for agents other than Codex and Claude Code. Other agents get documentation.
- Changes to navigation output, exit codes, routing, queueing, idle lifetime, or warm-up duration.
- Changes to the existing `daemon start`, `daemon status`, and `daemon stop` lines other than the additions below.
- Windows daemon reachability changes. Windows gets the warning and `--no-warnings` only.

## Interaction Model

### Ordinary commands

Navigation commands are unchanged, plus one flag accepted by every command in any position:

```console
$ symnav refs CheckoutService::processPayment --no-warnings
```

`--no-warnings` drops every warning line from stderr. Errors, exit codes, and stdout are unaffected. It does not change whether the daemon is used or telemetry is recorded.

### Daemon commands

```console
$ symnav daemon start
$ symnav daemon status
$ symnav daemon stop
```

`--cwd <dir>` selects the workspace, and with it the daemon. Commands never accept a daemon name, process id, or endpoint.

### Setup

```console
$ symnav setup codex
$ symnav setup claude-code
```

Takes exactly one agent name. Not accepted: no argument, several agents, or an unknown agent.

### Doctor

```console
$ symnav doctor
$ symnav doctor codex
```

With no argument, checks every supported agent found on the machine. With an agent name, checks only that agent.

### State location

Default `~/.symnav`; `SYMNAV_STATE_DIR` replaces it. Commands using different state locations never share or disturb each other's daemons. `setup` and `doctor` grant and check the state location in effect for the invocation, so a custom `SYMNAV_STATE_DIR` must also be set when running them.

## Output Format

Navigation output is unchanged when the state location is writable.

### Unwritable state location

One line on stderr per command, after any other stderr output:

```console
$ symnav overview src/orders.ts
src/orders.ts
  ...
symnav: warning: cannot write /Users/mo/.symnav (EPERM); daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.
```

Exit code is the command's own.

### `symnav setup`

Grant added:

```console
$ symnav setup codex
Granted write access to /Users/mo/.symnav in /Users/mo/.codex/config.toml
Restart Codex sessions to apply.
```

Already granted:

```console
$ symnav setup claude-code
Claude Code already grants write access to /Users/mo/.symnav (/Users/mo/.claude/settings.json)
```

Agent config invalid:

```console
$ symnav setup codex
symnav: error: cannot update /Users/mo/.codex/config.toml: invalid TOML at line 12
```

Exit code 1. The file is left unchanged.

### `symnav doctor`

```console
$ symnav doctor
codex        ok    daemon warm inside sandbox, telemetry recorded
claude-code  fail  sandbox denies write to /Users/mo/.symnav; run 'symnav setup claude-code'
```

Live sandbox check unavailable:

```console
claude-code  ok    configuration grants /Users/mo/.symnav; live sandbox check skipped: sandbox runtime not found
```

Agent not installed:

```console
codex        skip  not installed
```

Exit code 0 when no check failed, 1 otherwise.

### `daemon status`

Ready, starting, and busy daemons:

```console
$ symnav daemon status
/Users/mo/projects/reelcut  pid 48213  ready  up 14m  2142 files  1.3 GB  last request 8s ago
/Users/mo/projects/large-workspace  pid 48301  starting  12m  memory 2.1 GB
/Users/mo/projects/api  pid 48390  busy refs  43s  queued 2  memory 1.6 GB
```

No daemons:

```console
$ symnav daemon status
No daemons running.
```

Additions in this spec — recent fallbacks under a running daemon:

```console
/Users/mo/projects/reelcut  pid 48213  ready  up 14m  2142 files  1.3 GB  last request 8s ago
  3 fallbacks in last hour: daemon connection reset (ECONNRESET)
```

Last startup failure for a workspace with no running daemon:

```console
$ symnav daemon status
No daemons running.
/Users/mo/projects/reelcut  last startup failed 2m ago: endpoint bind denied (EPERM)
```

Additions appear only when there is something to report. A live busy daemon is never reported as absent because its current command is slow.

### `daemon stop`

```console
$ symnav daemon stop
Stopped daemon for /Users/mo/projects/reelcut (pid 48213)
```

```console
$ symnav daemon stop
No daemon running for /Users/mo/projects/reelcut
```

A daemon that does not stop within `5 s` is terminated:

```console
$ symnav daemon stop
Killed daemon for /Users/mo/projects/reelcut (pid 48213)
```

All cases exit `0`.

## Cross-cutting Concerns

### Warnings

- Prefix `symnav: warning:`, on stderr.
- Identical on every route.
- `--no-warnings` suppresses all of them.

### Failure reasons

Each recorded failure has:

- A named phase: `state location`, `endpoint create`, `endpoint bind`, `endpoint connect`, `process spawn`, `warm-up`, `worker`, `transfer`.
- The OS error code when one exists, for example `EPERM`, `EACCES`, `ECONNRESET`.
- A timestamp.

### Retention

`daemon status` shows failures and fallbacks from the last `1 hour`. Older records stay in diagnostics under existing rotation limits.

### Telemetry

Execution mode per command is `warm`, `cold`, or `fallback`. A command that cannot write the state location records nothing; its stderr warning is the signal.

### Platforms

Sandbox behavior applies on macOS and Linux. Windows gets the warning and `--no-warnings`; its daemon reachability is unchanged.

### Verification

- Sandboxed warm execution is covered by end-to-end tests that run the built CLI inside the Claude Code sandbox runtime and the Codex sandbox, asserting a later command is answered warm and recorded in telemetry. The Claude Code sandbox runtime suite runs in CI on macOS and Linux. The Codex sandbox suite runs where Codex is installed.
- `daemon status` and `daemon stop` are covered by end-to-end tests against the built binary for every output case in this spec.
- Warm-up completion is covered for both orders of worker replacement and end of warm-up.

## Sandboxed Warm Navigation

**Purpose:** an agent inside a granted sandbox gets warm answers.

**Does:**

- First command starts warm-up and answers locally.
- Later commands are answered by the daemon once ready.
- Telemetry records each command with its execution mode.

**Does not:**

- Require network access.
- Write outside the workspace and state location.
- Start a second daemon when an unsandboxed command already started one.

**Example:**

```console
$ symnav resolve PaymentProcessor          # inside Codex sandbox, cold, warm-up starts
$ symnav refs PaymentProcessor::charge     # inside Codex sandbox, warm once ready
$ symnav daemon status                     # outside sandbox
/Users/mo/projects/reelcut  pid 48213  ready  up 1m  2142 files  1.3 GB  last request 2s ago
```

**Edge cases:**

- Sandbox kills the daemon after the command ends: next command starts warm-up again; `daemon status` records the termination.
- State location writable but endpoint creation denied: command answers locally; failure recorded with phase `endpoint create`.
- Unsandboxed daemon already running, sandboxed command connects: answered warm.
- Worker replacement still running when warm-up finishes: daemon becomes ready after the replacement; startup does not fail.

## Unwritable State Location

**Purpose:** make a missing grant visible where an agent session is read.

**Does:** prints the warning line, answers locally, exits with the command's own code.

**Does not:**

- Create the state location elsewhere.
- Write telemetry or diagnostics anywhere.
- Retry or wait.
- Print more than one such line per command.

**Edge cases:**

- `--no-warnings`: no line; behavior otherwise identical.
- `SYMNAV_DAEMON=0` with telemetry on: warning still printed, because telemetry needs the write.
- `SYMNAV_DAEMON=0` and `SYMNAV_TELEMETRY=0`: no warning.
- State location missing and parent unwritable: same warning naming the state location.

## Setup

**Purpose:** grant the agent's sandbox write access to the state location in one command.

**Does:**

- Adds the state location to the agent's user-level sandbox write grants.
- Preserves all other content of the agent's config file.
- Creates the config file when absent.
- Is idempotent: a second run reports the grant exists and changes nothing.

**Does not:**

- Enable network access.
- Grant any other path.
- Change project-level agent config.
- Prompt for input.

**Edge cases:**

- Config file invalid: error, exit 1, file unchanged.
- Agent not installed: grant still written; output notes the agent was not found.
- Agent running: grant applies to new sessions; output says so.

## Doctor

**Purpose:** prove the daemon works inside each agent's sandbox.

**Does:**

- For each agent checked, runs a command inside that agent's sandbox against a scratch workspace and asserts it is answered warm and recorded in telemetry.
- Reports one line per agent: `ok`; `fail` with reason and fix; or `skip` with why.
- Falls back to a configuration check when the agent's sandbox cannot be run from the command line, and says the live check was skipped.

**Does not:**

- Change any configuration.
- Leave a daemon or scratch workspace behind.
- Need network access.

**Edge cases:**

- No supported agent installed: all lines `skip`, exit 0.
- State location unwritable for doctor itself: error, exit 1.

## Daemon Status and Stop

**Purpose:** a human sees what each daemon is doing and why one is missing, and can stop it.

**Does:** prints the lines in Output Format; adds fallback and failure lines from the last `1 hour`.

**Does not:** start a daemon, wait for warm-up, or print diagnostics beyond the lines shown.

**Edge cases:**

- Daemon busy with a long command: reported busy, never absent.
- Daemon not stopping within `5 s`: terminated; output says so.
- Several state locations: each command sees only its own.

## Summary

| Change                         | One line                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| Sandboxed warm navigation      | Daemon starts and answers inside sandboxes that grant the state location |
| Shared daemon                  | Sandboxed and unsandboxed commands share one daemon per workspace        |
| Contained state                | Everything the daemon creates lives in the state location                |
| Unwritable state warning       | One stderr warning per command; daemon and telemetry off                 |
| `--no-warnings`                | Silences warnings on every command; errors unaffected                    |
| `symnav setup <agent>`         | Grants Codex or Claude Code sandbox write access to the state location   |
| `symnav doctor`                | Proves warm execution and telemetry inside each agent's sandbox          |
| Named failure reasons          | Phase plus OS error code in diagnostics and `daemon status`              |
| Warm-up completion             | Worker replacement overlapping warm-up end never fails startup           |
| Status and stop coverage       | End-to-end tests for every status and stop output case                   |
