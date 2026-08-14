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

`overview` starts collapsed. Expand one area by depth, copied header text, or both.

```sh
symnav overview src/orders.ts
symnav overview src/orders.ts --depth 1
symnav overview src/orders.ts --at 'describe("cursor pagination")' --depth 2
```

`resolve` can match exact names, fuzzy subsequences, or JavaScript regexes.

```sh
symnav resolve PaymentProvider
symnav resolve --fuzzy payment
symnav resolve --regex '^to[A-Z].*'
```

## Telemetry

Symnav records local, shape-only usage telemetry by default. Each command appends one JSON line to `~/.symnav/usage.jsonl` with command name, timestamp, duration, outcome, enabled flag names, result-size counts, argument shape, `workspaceId`, `machineId`, `sessionId`, symnav version, and schema version.

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
