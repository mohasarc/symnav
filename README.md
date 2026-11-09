# symnav

Language-agnostic CLI for navigating codebases by symbol: definitions, references, and call paths. TypeScript and JavaScript supported today.

## Install

```sh
npm install -g symnav
```

Needs Node 20 or newer.

## Quick start

Run inside a Git repository. The workspace is the nearest Git root, or `--cwd <dir>`.

```sh
symnav overview src/orders.ts                # symbols in one file
symnav resolve PaymentProcessor              # find symbols and files by name
symnav def PaymentProcessor::charge          # where it's defined
symnav refs PaymentProcessor::charge         # every reference
symnav context PaymentProcessor::charge      # definition, callers, callees, recent history
```

`def`, `refs`, `context`, and `graph` take a target: any unique suffix of the symbol's id, like `charge`, `orders.ts::PaymentProcessor`, or `src/orders.ts::PaymentProcessor::charge`. An ambiguous target lists candidates to copy. `--regex` matches full ids instead, and `--json` gives machine output on every navigation command.

## Agent setup

Install the symnav skill so your agent knows when and how to call it. The `skills` CLI needs Node 22.20 or newer; add `-g` to install for your user instead of the project.

```sh
npx skills add mohasarc/symnav --skill symnav
```

The skill lives in [`skills/symnav`](https://github.com/mohasarc/symnav/blob/main/skills/symnav/SKILL.md).

Codex and Claude Code sandboxes usually block writes to `~/.symnav`, so every command runs cold and warns on stderr. Grant access once, check it, then restart the agent session:

```sh
symnav setup codex          # or: symnav setup claude-code
symnav doctor
```

## Stability

symnav follows semver from 1.0. A major version is needed to change command names, flags, target syntax (`::` suffixes, `--regex`), exit codes, the `Cannot answer:` refusal prefix, environment variables (`SYMNAV_DAEMON`, `SYMNAV_TELEMETRY`, `SYMNAV_STATE_DIR`), or the state directory location, or to remove or rename a `--json` output field. New `--json` fields, text output layout, hint and warning wording, daemon internals and policy defaults, and telemetry shape can change in any release.

## Telemetry

Local only, nothing is sent anywhere. Each command appends one line to `~/.symnav/usage.jsonl`: command name, timestamp, duration, outcome, execution mode (`warm`, `cold`, `fallback`), flag names, result-size counts, argument shape, version, a hashed workspace id, and random machine and session ids. It never records symbol names, file paths, queries, source, or output.

Opt out with `SYMNAV_TELEMETRY=0` (also `false`, `off`, `no`). Then symnav writes no telemetry at all.

## Docs

- [`docs/navigation.md`](https://github.com/mohasarc/symnav/blob/main/docs/navigation.md): commands, targets, output, errors
- [`docs/daemon.md`](https://github.com/mohasarc/symnav/blob/main/docs/daemon.md): workspace daemon, agent sandboxes, `setup`, `doctor`
- [`docs/daemon-policy.md`](https://github.com/mohasarc/symnav/blob/main/docs/daemon-policy.md): daemon timeouts and limits

## Development

See [`CONTRIBUTING.md`](https://github.com/mohasarc/symnav/blob/main/CONTRIBUTING.md). Licensed under [Apache-2.0](https://github.com/mohasarc/symnav/blob/main/LICENSE).
