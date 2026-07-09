---
name: symnav
description: Navigate a TypeScript codebase by symbol from the CLI — a file's symbol tree (overview), find a symbol by name (resolve), where it's defined (def), every reference to it (refs), direct context (context), and multi-hop call paths (graph). Use it for deterministic project-wide orientation and symbol navigation before deciding which files, tests, and implementation regions to inspect with normal tools.
---

`symnav` gives deterministic, project-wide answers to navigation questions: what is in a TypeScript file, where a symbol is defined, who references it, and how calls flow around it. Use it early to orient yourself and choose what to inspect next. Then use `Read`, `rg`, tests, and edits normally; symnav is a navigation layer, not a replacement for reading code.

Run from inside a git workspace. `--cwd <dir>` to point elsewhere; `--json` on any command for machine output. In Codex-style environments, pass `yield_time_ms: 60000` on every `exec_command` call that invokes `symnav`; cold TypeScript startup can yield early with empty output, and that is not the command result.

## Default playbook

Use this sequence unless the task gives you a more specific starting point:

1. **Start with project orientation.** Run `symnav resolve '<domain word>'` for one name from the task, error message, failing test, or API surface. Use one query per command; do not pass several symbol names to a single `resolve`. If you already know a likely file, run `symnav overview <file> --depth 0` for a top-level map.
2. **Turn candidates into a target.** Copy the most relevant canonical target from `resolve` or `overview`, then run `symnav def '<target>'` for the exact declaration. Use `def` before opening the file when you need the implementation location or signature.
3. **Orient on the blast radius.** Run `symnav context <target>` before changing a function, class, method, exported type, public helper, or shared test fixture. Read the callers/callees first; they tell you what your patch can break and what nearby code to inspect next.
4. **Use references for API changes.** Run `symnav refs <target> --all` before renaming, changing parameters, changing return shapes, changing overloads, or touching exported behavior. Patch the references the tool shows; do not grep for the name first.
5. **Escalate to graph when one hop is not enough.** Run `symnav graph <target> --incoming --depth 2` to find indirect callers of behavior you are about to change. Run `symnav graph <target> --outgoing --depth 2` when a function delegates through helpers and you need the implementation chain.
6. **Read the code you need.** Open files with `sed`/Read once symnav has oriented you to the right file, symbol, call site, or test. Use text search for prose, config, non-TypeScript files, generated names, or any case where symbol navigation is not the right tool.

Good runs usually look like `resolve/overview -> def/context -> refs/graph when needed -> read relevant code/tests -> patch`. If you catch yourself searching for a TypeScript symbol name with `rg`, consider whether `symnav resolve` or `symnav refs` would give a cleaner map first.

## Which command, when

| When you need…                            | Use                | Gives you                                                                      |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| A file map before reading                 | `overview <file>`  | Symbol/fold tree. Start at `--depth 0`, then add `--depth` or `--at` to expand only the part you need. |
| A symbol or likely file                   | `resolve <query>`  | Every symbol/file matching the name. Add `resolve --regex` for JavaScript regex search. |
| A declaration location                    | `def <target>`  | Exact file, line range, and signature where a unique suffix target is defined. |
| Call sites or usage sites                 | `refs <target>` | Every reference workspace-wide, grouped by file, tagged by kind, paginated.    |
| Local blast radius                        | `context <target>` | One block: definition, direct callers, direct callees, reference summary, recent git history. |
| Multi-hop call paths                      | `graph <target>` | Incoming and outgoing call paths with depth, direction, pagination, and possible-edge labels. |

`context` is workspace-only and certain-edges-only: callers/callees count just statically-resolved calls to non-ignored workspace files, capped at 20 per direction. Use `graph` when possible/dynamic edges or multi-hop traversal matter. An ambiguous target is refused; copy one printed candidate and query that directly.

## Task recipes

**Fix a failing test**

1. Run `symnav resolve '<test name or failing symbol>'`.
2. If the failing file is known, run `symnav overview <test-file> --depth 0`, then expand with `--depth 1`, `--depth 2`, or `--at '<header>'` if the relevant test block is nested.
3. Run `symnav context '<implementation target>'` for the code under test.
4. Run `symnav refs '<implementation target>' --all` when changing public behavior.

**Add or change an API**

1. Run `symnav resolve '<API name>'` to find the declaration.
2. Run `symnav def '<target>'` for the exact signature.
3. Run `symnav refs '<target>' --all` before editing.
4. Run `symnav graph '<target>' --incoming --depth 2` if the API is called through wrappers, adapters, routers, commands, plugins, or framework registration.

**Trace unfamiliar behavior**

1. Run `symnav resolve '<verb or type name>'`.
2. Run `symnav context '<target>'` for the best candidate.
3. If the context output says callers/callees overflow, run the suggested `symnav graph` command.
4. Use `overview --at` only after you know the file and need a specific nested block.

**Refactor safely**

1. Run `symnav refs '<target>' --all` before the first edit.
2. Run `symnav graph '<target>' --incoming --depth 2` for shared methods and exported helpers.
3. Patch the declaration and every reference class of call site the output shows.
4. Re-run `symnav refs` after the patch if the target still exists and should have fewer/no references.

## Command hygiene

Pass exactly one symbol query or target per command. These are good:

```
$ symnav resolve 'selectorHealth'
$ symnav resolve 'resetContext'
$ symnav context 'src/context.ts::resetContext'
```

This is bad because `resolve` receives one long query, not four searches:

```
$ symnav resolve resetContext selectorHealth selector dependencies
```

Quote targets with single quotes whenever they contain shell-sensitive characters such as `$`, `*`, `[`, `]`, `(`, `)`, `!`, spaces, or quotes from test names. Without quotes, the shell can rewrite the target before symnav sees it:

```
$ symnav resolve '$find'
$ symnav def 'core/crud/crud.service.ts::$find'
$ symnav context 'core/crud/crud.service.ts::$find'
```

Choose depth based on the task. Start with `--depth 0` when you need a map, then increase depth when the interesting code is nested:

```
$ symnav overview src/file.ts --depth 0
$ symnav overview src/file.ts --depth 1
$ symnav overview src/file.ts --depth 2
$ symnav overview src/file.ts --depth 3
```

When you know the symbol, class, function, or test block you care about, expand only that part with `--at`:

```
$ symnav overview src/file.ts --at 'class MatchExpression' --depth 2
$ symnav overview src/file.ts --at 'describe("cursor pagination")' --depth 2
```

For behavior spread through dispatchers, adapters, framework registration, plugin hooks, generated builders, or callbacks, use `graph` rather than repeatedly opening files:

```
$ symnav graph 'src/file.ts::target' --incoming --depth 2
$ symnav graph 'src/file.ts::target' --outgoing --depth 3
```

## Suffix-pattern Targets

Symbol commands accept a suffix of the canonical id, not only the full id. These suffix-pattern targets let you use the shortest target that is unique, then copy a candidate when ambiguity is reported:

```
$ symnav def charge
$ symnav def orders.ts::charge
$ symnav def src/orders.ts::PaymentProcessor::charge
```

Unique targets proceed. Ambiguous targets print canonical candidates with declarations; copy one of those candidates into `def`, `refs`, `context`, or `graph`.

`resolve` remains the search/listing command. It does not auto-proceed into definitions.

## Overview Expansion

Start with a depth-zero overview, then expand by depth or by copied header text:

```
$ symnav overview src/orders.ts --depth 0
$ symnav overview src/orders.ts --depth 1
$ symnav overview src/orders.ts --depth 2
$ symnav overview src/orders.ts --at 'describe("cursor pagination")' --depth 2
```

`--at <text>` matches text from an overview header, including fold headers such as `describe(...)`, `if (...)`, and loops. If several nodes match, `overview` prints candidates; copy more of the desired header. `--line <n>` is only a narrowing filter, and same-line/minified code may still require `--at`.

## Warning Behavior

The warning behavior is intentionally non-fatal. Warnings are diagnostics on stderr; read them, but if the process exits 0, stdout is still the navigation result.

## Exploring with `context`

When you land on an unfamiliar symbol, `context` is the one call that orients you: what it is, who depends on it (blast radius before you change it), what it leans on, how heavily it's referenced, and how it's changed lately. That's the work of `def` + `refs` + reading caller files + `git log` — collapsed into one block.

```
$ symnav context apps/cli/src/command.ts::runCommand

Context: runCommand
File: apps/cli/src/command.ts
Lines: 37-85

Definition
└── 37-85: runCommand  [implementation]
    export async function runCommand<Result, Args>(...): Promise<void>

Callers                          # who breaks if you change this — 5 register-*-command.ts sites
├── …/def/register-def-command.ts
│   └── 8-27: registerDefCommand  [call]
│             await runCommand(defCommand, {
└── …/refs/register-refs-command.ts
    └── 16-45: registerRefsCommand  [call]

Callees                          # what this leans on — its signature shown inline
├── 87-136: recordTelemetry  [call ×2]
└── 144-153: handleError  [call]

References
Total: 27
Kinds: usage 21, import 6
Run: symnav refs apps/cli/src/command.ts::runCommand

Recent History                   # is this hot or stable? who last touched it?
1. 3c53915 2026-06-23 Mohammed S. Yaseen
   feat(cli): thread GitHistory through dependencies and context
```

Read it top-down: **Callers = blast radius** (every site you must check before editing), **Callees = dependencies** (what to read next to understand the body), **References + History** = how load-bearing and how active it is. `[call ×N]` means one caller hits it N times; overflow past 20 points you at `graph`. Start a change here, not with `Read`.

## How to drive it

`def`/`refs`/`context`/`graph` need a **target pattern**:

```
<Segment>
<file-suffix>::<Segment>[::<Segment>...]
<relative-file-path>::<Segment>[::<Segment>...]
```

Examples:

```
charge
PaymentProvider.ts::charge
src/payments/PaymentProvider.ts::PaymentProvider::charge
```

Normal flow: **`resolve` a name → copy a candidate if needed → `def` to read it / `refs` to see who uses it.** Or `overview <file>` to get symbol headers and fold headers before targeted expansion.

## Reading output

Tree glyphs show nesting; `start-end: QualifiedName` then the signature line:

```
├── 1-9: PaymentProcessor
│   1 export class PaymentProcessor
│   └── 2-4: PaymentProcessor::charge
│       2 charge(amount: number): string
```

`refs` adds a header (`Total`, `Kinds: usage 7, import 5, …`, `Page`) then references as `<line>: <preview>  [<kind>]`, grouped by file. Long lines trimmed to a preview (`…`).

## Options

- `overview` — `--depth <n>`, `--at <text>`, `--line <n>`
- `resolve` — `--fuzzy` (subsequence match, not exact), `--regex` (JavaScript regex; cannot combine with `--fuzzy`)
- `refs` — `--page <n>`, `--page-size <n>`, `--all` (one page), `--full-lines` (untrimmed source)
- `graph` — `--incoming`, `--outgoing`, `--depth <n>`, `--page <n>`, `--page-size <n>`, `--all`
- all — `--json`
