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

Daemons exit after 30 minutes without navigation work, when their workspace is deleted, or when resident memory exceeds one quarter of system memory, bounded between 256 MiB and 4 GiB. A daemon startup, connection, or response failure runs that invocation locally once; a later eligible invocation can start a replacement.

Registry records and per-workspace JSON diagnostic logs live under `~/.symnav/daemons/`. Set `SYMNAV_STATE_DIR` to relocate all symnav state; daemon files then live under `$SYMNAV_STATE_DIR/daemons/`. Diagnostics are not written to command stdout or stderr.

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
