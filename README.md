# symnav

A CLI for navigating TypeScript codebases by symbol.

## Commands

`overview`, `resolve`, `def`, and `refs` navigate symbols. `context <target>` prints one block per symbol: its definition, direct callers, direct callees, a reference summary, and recent git history.

`context` is workspace-only and certain-edges-only. Callers and callees count only statically-resolved calls to non-ignored workspace files, capped at 20 per direction; overflow points at `graph`. Possible and dynamic edges (element-access dispatch, calls into `node_modules`) are dropped here — `graph` surfaces them. An ambiguous target is refused with `Cannot answer:`; copy one printed candidate and query that directly.

`def`, `refs`, `context`, and `graph` accept structured suffix targets by default. Use the shortest target that is unique; when a target is ambiguous, copy one printed candidate.

```sh
symnav def charge
symnav refs PaymentProvider.ts::charge
symnav context src/payments/PaymentProvider.ts::PaymentProvider::charge
```

Use `--regex` for a case-sensitive JavaScript regex over full canonical symbol IDs.

```sh
symnav def --regex 'PaymentProcessor::charge$'
symnav refs --regex 'src/payments/.+::charge$'
symnav context --regex '::build[A-Z][^:]*$'
symnav graph --regex 'Router::dispatch#[1-3]$'
```

`overview` starts collapsed. Expand one area by depth, copied header text, or both. When `--at` text matches several entries, one whose symbol path or header equals the text exactly wins over longer substring matches, so `--at Greeter` selects the class, not its members.

```sh
symnav overview src/orders.ts
symnav overview src/orders.ts --depth 1
symnav overview src/orders.ts --at 'describe("cursor pagination")' --depth 2
```

`resolve` can match exact names, fuzzy subsequences, or JavaScript regexes. An exact query with no match ends with a hint to retry with `--fuzzy` or `--regex`.

```sh
symnav resolve PaymentProvider
symnav resolve --fuzzy payment
symnav resolve --regex '^to[A-Z].*'
```

## Workspace daemon

Workspace commands use a per-workspace daemon by default. The first eligible command starts and warms it; later commands reuse retained TypeScript state while preserving the same output and exit status as cold execution. Set `SYMNAV_DAEMON=0` to run commands locally without creating or using a daemon.

Use the lifecycle commands to manage daemon processes explicitly:

```sh
symnav daemon start
symnav daemon status
symnav daemon stop
symnav daemon status --json
```

`start`, `status`, and `stop` all accept `--json`. `start` and `stop` select the workspace from the current directory or global `--cwd`; `status` lists every validated daemon in workspace-path order.

Daemons exit after 30 minutes without navigation work, when their workspace is deleted, or when resident memory exceeds one quarter of system memory, bounded between 256 MiB and 4 GiB. A failure before request submission permits one local attempt; submitted or accepted requests are never replayed locally. A later eligible invocation can start a replacement.

Warm-up follows navigation worker replacements caused by memory pressure. Readiness and startup diagnostics describe the current worker after resource checks; an obsolete worker finishing or stopping does not fail a healthy replacement.

Registry records and per-workspace JSON diagnostic logs live under `~/.symnav/daemons/`. Set `SYMNAV_STATE_DIR` to relocate all symnav state; daemon files then live under `$SYMNAV_STATE_DIR/daemons/`. Diagnostics are not written to command stdout or stderr.

`daemon status` adds fallback counts and the latest reason from the last hour below each running daemon. A workspace without a live daemon shows its last startup failure from that hour, including the operating-system error code when available. Busy and unresponsive processes remain listed. Status never starts a daemon or waits for warm-up; JSON keeps `schemaVersion: 1` and adds optional `recentFallbacks` and `startupFailures` fields.

Failure history survives registry cleanup. Records contain named phases and reasons, timestamps, workspace coordinates, and optional OS codes; they omit error messages, stacks, source content, and environment values. Older evidence stays under the diagnostic rotation budget: 10 MiB per log with four backups, plus up to 50 MiB of immutable failure history per workspace identity. A request contributes at most one fallback. Graceful, idle, resource, and workspace-deleted shutdown reasons remain in diagnostic logs.

`daemon stop` lets accepted work finish within its five-second total deadline, then requests authenticated termination if needed. A short control-response timeout does not shorten that grace period.

On macOS and Linux, daemon communication uses regular files inside the state directory. An agent sandbox needs workspace read access and write access to `~/.symnav` (or the effective `SYMNAV_STATE_DIR`); it needs no network or Unix-socket grant. Sandboxed and unsandboxed commands selecting the same workspace and state directory share one daemon. Windows retains named pipes.

POSIX daemon ownership requires the standard `mkfifo` executable on `PATH` and a state filesystem that supports FIFOs. Node 20 remains supported. FIFO readers prove process lifetime across PID namespaces; displayed PIDs belong to the daemon’s own namespace and are not host signal targets. Starting and ready daemons stop through authenticated controls; success requires confirmed process exit. A live daemon that cannot authenticate within the stop deadline retains ownership. Unreachable legacy PID-only owners are retained conservatively. Explicit start reports failure when matched legacy startup ownership cannot be verified, leaving the owner and record intact. If a sandbox wrapper terminates its descendants, the next command starts a fresh cold warm-up; symnav does not extend the wrapper lifetime.

Run `symnav setup codex` or `symnav setup claude-code` to grant write access to the effective state directory in the agent's user config. `CODEX_HOME` selects the config directory; otherwise it uses `~/.codex/config.toml`. Set the same `SYMNAV_STATE_DIR` when running setup and navigation:

```bash
symnav setup codex
symnav setup claude-code
SYMNAV_STATE_DIR=/path/to/state symnav setup codex
```

Setup preserves existing config content, comments, file permissions, network policy and other grants. It updates legacy `sandbox_workspace_write.writable_roots` or the selected named permission profile. A built-in profile receives a derived profile that inherits its policy and adds only the state path. Existing grants remain unchanged. Setup never changes the legacy sandbox mode; read-only sessions still need a supported write-capable sandbox policy. Restart agent sessions after a change. The grant is written even when Codex is not installed, with a note in the output. Invalid TOML, conflicting legacy/named selections and exact state denials fail without changing the config. Claude Code uses `~/.claude/settings.json`, or `settings.json` inside `CLAUDE_CONFIG_DIR` when set. Setup adds only `sandbox.filesystem.allowWrite`; it preserves sandbox enablement, network settings, deny lists and permission rules. It never enables sandboxing or removes a conflicting deny rule. Invalid JSON, duplicate keys and mistyped grant nodes fail without changing the file. Other agents can grant the state directory manually.

Run `symnav doctor` to check Codex then Claude Code, or select one supported agent:

```bash
symnav doctor
symnav doctor codex
SYMNAV_STATE_DIR=/path/to/state symnav doctor claude-code
```

Use the same `SYMNAV_STATE_DIR`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` as setup and navigation. Doctor checks the original user policy, creates a scratch workspace and isolated telemetry under the selected state directory, and keeps the sandbox wrapper alive through cold execution, readiness and a warm command. Success requires recorded warm telemetry. It stops only scratch work, waits for owned processes to exit and removes its scratch files. If owned exit cannot be confirmed, it fails and preserves scratch rather than deleting live process state. User configuration and existing telemetry remain unchanged. An unwritable state directory is an error, including with `--no-warnings`. Doctor uses isolated probe state even when normal daemon use and telemetry recording are opted out.

Live checks use the installed Codex sandbox command or the standalone Claude sandbox runtime, `srt`, on `PATH`; no authenticated agent or model session runs. Claude Code's interactive sandbox enablement setting is preserved: doctor explicitly starts standalone SRT with the configured filesystem rules and network disabled. If a runtime is genuinely unavailable, a valid grant produces an explicit configuration-only result. A missing or denied grant, an unsupported policy translation, and an installed runtime that rejects or fails the proof produce `fail` and exit 1. No installed agents produce `skip` and exit 0. Doctor status lines remain visible with `--no-warnings`.

Recorded daemon startup failures include the phase, reason, optional OS error code and affected workspace. The workspace identifies the probe; it is not the original failing write path. Investigate the reported startup condition, then rerun doctor.

Doctor directs the Claude runtime's temporary files to its existing scratch workspace. It does not depend on a global `/tmp/claude` directory or add filesystem grants for temporary files.

Setup never removes denies or changes read-only session policy. Restart agent sessions after granting access; existing project or managed session restrictions can still deny it. For other agents, manually allow writes to the effective state directory and reads of the workspace. Keep state outside project configuration and grant no network, TCP, or Unix-socket permission for symnav. Doctor's live probe also runs without network access. See [Codex permissions](https://developers.openai.com/codex/permissions) and [Claude sandbox filesystem settings](https://code.claude.com/docs/en/sandboxing) for agent policy syntax.

When a required state write fails, symnav disables daemon and telemetry work for that invocation. Navigation executes locally when no request has been submitted; accepted work keeps its result or controlled failure. One warning follows ordinary stderr, and the command keeps its own exit code:

```text
symnav: warning: cannot write /Users/mo/.symnav (EPERM); daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.
```

Use global `--no-warnings` before the command, between command arguments, or at the end to suppress all warning emissions. It preserves errors, stdout, exit status, daemon routing, and telemetry. Extraction warnings use the `symnav: warning:` prefix. A literal `--no-warnings` after `--` or as an option value remains an argument.

Grant the sandbox write access to the effective state directory. Help, version, and read-only commands do not warn when they need no write. With both `SYMNAV_DAEMON=0` and `SYMNAV_TELEMETRY=0`, navigation commands never access state; `stats` consequently reports an empty summary. To read existing stats without recording another event, run `SYMNAV_DAEMON=1 SYMNAV_TELEMETRY=0 symnav stats --json`.

Command and result spill files also stay inside state and are removed after delivery. Setting both `SYMNAV_DAEMON=0` and `SYMNAV_TELEMETRY=0` runs navigation directly without accessing state or creating spill files.

## Telemetry

Symnav records local, shape-only usage telemetry by default. Each command appends one JSON line to `~/.symnav/usage.jsonl` with command name, timestamp, duration, outcome, execution mode (`warm`, `cold`, or `fallback`), enabled flag names, result-size counts, argument shape, `workspaceId`, `machineId`, `sessionId`, symnav version, and schema version.

Telemetry does not record symbol names, file paths, query strings, source previews, or command output. `machineId` is stored in `~/.symnav/machine-id`; `workspaceId` is derived from the git remote URL when available, with a workspace-path fallback.

Set `SYMNAV_TELEMETRY` to `0`, `false`, `off`, or `no` (case-insensitive) to disable telemetry. When disabled, `symnav` does not create the telemetry directory and does not write `usage.jsonl`.

## Development

Install dependencies and build the workspace before running tests; e2e tests exercise the built binary, not source.

```sh
pnpm install
pnpm build
pnpm test
```

To run the CLI from source during development, use the `dev` script in `apps/cli`:

```sh
pnpm --filter symnav dev --version
```

Real sandbox checks use pinned `@anthropic-ai/sandbox-runtime` on macOS and Linux, which requires Node 22.12 or newer. Linux needs `bubblewrap`, `socat`, `ripgrep`, and working unprivileged user namespaces. Run `pnpm --filter symnav exec vitest run test/e2e/sandbox/warm-navigation.test.ts test/e2e/sandbox/doctor.test.ts` after building. Set `SYMNAV_REQUIRE_SANDBOX_RUNTIME=1` to fail when runtime prerequisites are unavailable; CI requires this on both platforms and uses Node 22 for sandbox jobs. Main compatibility checks continue to use Node 20. Installed Codex runtimes run the same checks with an isolated configuration.
