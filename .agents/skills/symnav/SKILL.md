---
name: symnav
description: Navigate a TypeScript codebase by symbol from the CLI — a file's symbol tree (overview), find a symbol by name (resolve), where it's defined (def), every reference to it (refs), direct context (context), and multi-hop call paths (graph). Each call returns only what you asked for, structured, at a fraction of the tokens Read/grep burn. One `context` call replaces a dozen Read/grep round-trips and hands you a symbol's blast radius instantly; `graph` expands that blast radius across call paths. Read this skill once and every `.ts`/`.tsx` question you face afterward gets cheaper and sharper; skip it and you'll burn thousands of tokens doing by hand what one command does. Reach for it first, before any Read or grep on TypeScript.
---

**Stop opening files to find things.** `Read` dumps whole files into your context — most of it noise you'll never use. `grep` floods you with line matches and no structure. Both rot your context and burn tokens. `symnav` answers the actual question — "what's in this file", "where is this defined", "who calls it" — and returns _only that_, structured. Use it first; fall back to Read/grep only when symnav can't answer.

Run from inside a git workspace. `--cwd <dir>` to point elsewhere; `--json` on any command for machine output. In Codex-style environments, pass `yield_time_ms: 60000` on every `exec_command` call that invokes `symnav`; cold TypeScript startup can yield early with empty output, and that is not the command result.

## Which command, when

| Instead of…                               | Use                | Gives you                                                                      |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `Read`-ing a file to see what it contains | `overview <file>`  | One-screen symbol/fold tree. Add `overview --depth` or `overview --at` to expand only the part you need. |
| `grep`-ing for a name across the repo     | `resolve <query>`  | Every symbol/file matching the name. Add `resolve --regex` for JavaScript regex search. |
| `Read` + scrolling to find a declaration  | `def <target>`  | Exact file, line range, and signature where a unique suffix target is defined. |
| `grep`-ing for a name to find call sites  | `refs <target>` | Every reference workspace-wide, grouped by file, tagged by kind, paginated.    |
| Stitching `def` + `refs` + blame by hand  | `context <target>` | One block: definition, direct callers, direct callees, reference summary, recent git history. |
| Tracing call paths across multiple hops   | `graph <target>` | Incoming and outgoing call paths with depth, direction, pagination, and possible-edge labels. |

`context` is workspace-only and certain-edges-only: callers/callees count just statically-resolved calls to non-ignored workspace files, capped at 20 per direction. Use `graph` when possible/dynamic edges or multi-hop traversal matter. An ambiguous target is refused; copy one printed candidate and query that directly.

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

Start with a shallow overview, then expand by copied header text:

```
$ symnav overview src/orders.ts
$ symnav overview src/orders.ts --depth 1
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
