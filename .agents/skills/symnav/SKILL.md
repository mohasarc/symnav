---
name: symnav
description: Navigate a TypeScript codebase by symbol from the CLI — a file's symbol tree (overview), find a symbol by name (resolve), where it's defined (def), every reference to it (refs), direct context (context), and multi-hop call paths (graph). Provides deterministic project-wide orientation and symbol navigation alongside normal reads, search, tests, and edits.
---

`symnav` gives deterministic, project-wide answers to navigation questions: what is in a TypeScript file, where a symbol is defined, who references it, and how calls flow around it. It is a navigation layer for TypeScript code, used alongside normal file reads, text search, tests, and edits.

Run from inside a git workspace. `--cwd <dir>` points at a different workspace; `--json` on any command gives machine-readable output. In Codex-style environments, pass a generous `yield_time_ms` on commands that may take time; cold TypeScript startup can yield early with empty output, and that is not the final command result.

## Which command, when

| When you need…                            | Use                | Gives you                                                                      |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| A file map before reading                 | `overview <file>`  | Symbol/fold tree for one `.ts`/`.tsx` source file. `--depth` controls nesting; `--at` selects matching symbols, test blocks, or file regions from the output. |
| A symbol or likely file                   | `resolve <query>`  | Every symbol/file matching the name. Add `resolve --regex` for JavaScript regex search. |
| A declaration location                    | `def <target>`  | Exact file, line range, and signature where a unique suffix target is defined. |
| Call sites or usage sites                 | `refs <target>` | Every reference workspace-wide, grouped by file, tagged by kind, paginated.    |
| Local blast radius                        | `context <target>` | One block: definition, direct callers, direct callees, reference summary, recent git history. |
| Multi-hop call paths                      | `graph <target>` | Incoming and outgoing call paths with depth, direction, pagination, and possible-edge labels. |

`context` is workspace-only and certain-edges-only: callers/callees count just statically-resolved calls to non-ignored workspace files, capped at 20 per direction. `graph` covers multi-hop traversal and can include possible/dynamic edges. An ambiguous target is refused; copy one printed candidate and query that directly.

## Command hygiene

Pass exactly one symbol query or target per command. These are good:

```
$ symnav resolve 'selectorHealth'
$ symnav resolve 'resetContext'
$ symnav context 'src/context.ts::resetContext'
```

Use workspace-relative file paths in symbol targets. Do not include the container or checkout root such as `/app`; write `src/context.ts::resetContext`, not `/app/src/context.ts::resetContext`. If an overview header shows `src/context.ts` and `resetContext`, combine them as `src/context.ts::resetContext` or use the shorter suffix if it is unique.

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

`overview` depth controls how much nesting appears:

```
$ symnav overview src/file.ts --depth 0
$ symnav overview src/file.ts --depth 1
$ symnav overview src/file.ts --depth 2
$ symnav overview src/file.ts --depth 3
```

`--at` can select a matching symbol, class, function, or test block:

```
$ symnav overview src/file.ts --at 'class MatchExpression' --depth 2
$ symnav overview src/file.ts --at 'describe("cursor pagination")' --depth 2
```

`graph` can show incoming or outgoing call paths:

```
$ symnav graph 'src/file.ts::target' --incoming --depth 2
$ symnav graph 'src/file.ts::target' --outgoing --depth 3
```

Depth controls the number of hops. `--incoming` follows callers; `--outgoing` follows callees.

## Suffix-pattern Targets

Symbol commands accept a suffix of the canonical id, not only the full id. These suffix-pattern targets let you use the shortest target that is unique, then copy a candidate when ambiguity is reported:

```
$ symnav def charge
$ symnav def orders.ts::charge
$ symnav def src/orders.ts::PaymentProcessor::charge
```

Unique targets proceed. Ambiguous targets print canonical candidates with declarations; copy one of those candidates into `def`, `refs`, `context`, or `graph`.
If symnav says a target is ambiguous, that is expected: choose the candidate that matches the runtime symbol you need and retry with that exact candidate string.
If symnav says no symbol target was found, re-check that the file path is workspace-relative and that the symbol name appears in `overview`, `resolve`, or the candidate output.

`resolve` remains the search/listing command. It does not auto-proceed into definitions.

## Overview Expansion

`overview` can show a top-level file map or a nested section selected by header text:

```
$ symnav overview src/orders.ts --depth 0
$ symnav overview src/orders.ts --depth 1
$ symnav overview src/orders.ts --depth 2
$ symnav overview src/orders.ts --at 'describe("cursor pagination")' --depth 2
```

`overview` accepts one TypeScript source file, not a directory. These are wrong:

```
$ symnav overview src --depth 0
$ symnav overview packages --depth 0
```

Use a TypeScript source file path with `overview`.

`--at <text>` matches text from an overview header, including fold headers such as `describe(...)`, `if (...)`, and loops. If several nodes match, `overview` prints candidates; copy more of the desired header. `--line <n>` is only a narrowing filter, and same-line/minified code may still require `--at`.

## Warning Behavior

The warning behavior is intentionally non-fatal. Warnings are diagnostics on stderr; read them, but if the process exits 0, stdout is still the navigation result.

## Context Output

`context` combines one symbol's definition, direct callers, direct callees, reference summary, and recent git history.

```
$ symnav context apps/cli/src/command.ts::runCommand

Context: runCommand
File: apps/cli/src/command.ts
Lines: 37-85

Definition
└── 37-85: runCommand  [implementation]
    export async function runCommand<Result, Args>(...): Promise<void>

Callers
├── …/def/register-def-command.ts
│   └── 8-27: registerDefCommand  [call]
│             await runCommand(defCommand, {
└── …/refs/register-refs-command.ts
    └── 16-45: registerRefsCommand  [call]

Callees
├── 87-136: recordTelemetry  [call ×2]
└── 144-153: handleError  [call]

References
Total: 27
Kinds: usage 21, import 6
Run: symnav refs apps/cli/src/command.ts::runCommand

Recent History
1. 3c53915 2026-06-23 Mohammed S. Yaseen
   feat(cli): thread GitHistory through dependencies and context
```

`[call ×N]` means one caller hits the target N times. Overflow past 20 points to `graph`.

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

`resolve` lists candidate symbols. `def`, `refs`, `context`, and `graph` accept target patterns. `overview <file>` lists symbol headers and fold headers for one TypeScript file.

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
