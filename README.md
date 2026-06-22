# symnav

A CLI for navigating TypeScript codebases by symbol.

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
