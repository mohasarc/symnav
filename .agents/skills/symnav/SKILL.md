---
name: symnav
description: Navigate a TypeScript codebase by symbol from the CLI — a file's symbol tree (overview), find a symbol by name (resolve), where it's defined (def), every reference to it (refs), direct context (context), and multi-hop call paths (graph). Each call returns only what you asked for, structured, at a fraction of the tokens Read/grep burn. One `context` call replaces a dozen Read/grep round-trips and hands you a symbol's blast radius instantly; `graph` expands that blast radius across call paths. Read this skill once and every `.ts`/`.tsx` question you face afterward gets cheaper and sharper; skip it and you'll burn thousands of tokens doing by hand what one command does. Reach for it first, before any Read or grep on TypeScript.
---

**Stop opening files to find things.** `Read` dumps whole files into your context — most of it noise you'll never use. `grep` floods you with line matches and no structure. Both rot your context and burn tokens. `symnav` answers the actual question — "what's in this file", "where is this defined", "who calls it" — and returns _only that_, structured. Use it first; fall back to Read/grep only when symnav can't answer.

Run from inside a git workspace. `--cwd <dir>` to point elsewhere; `--json` on any command for machine output. In Codex-style environments, pass `yield_time_ms: 60000` on every `exec_command` call that invokes `symnav`; cold TypeScript startup can yield early with empty output, and that is not the command result.

## Default playbook

Use this sequence unless the task gives you a more specific starting point:

1. **Start broad with symbols, not text.** Run `symnav resolve <domain word>` for names from the task, error message, failing test, or API surface. If you already know a likely file, run `symnav overview <file> --depth 1`.
2. **Turn candidates into a target.** Copy the most relevant canonical target from `resolve` or `overview`, then run `symnav def <target>` for the exact declaration. Use `def` before opening the file when you need the implementation location or signature.
3. **Orient on the blast radius.** Run `symnav context <target>` before changing a function, class, method, exported type, public helper, or shared test fixture. Read the callers/callees first; they tell you what your patch can break and what nearby code to inspect next.
4. **Use references for API changes.** Run `symnav refs <target> --all` before renaming, changing parameters, changing return shapes, changing overloads, or touching exported behavior. Patch the references the tool shows; do not grep for the name first.
5. **Escalate to graph when one hop is not enough.** Run `symnav graph <target> --incoming --depth 2` to find indirect callers of behavior you are about to change. Run `symnav graph <target> --outgoing --depth 2` when a function delegates through helpers and you need the implementation chain.
6. **Only then read files.** Open a file with `sed`/Read when symnav has given you the exact region to inspect, when you need surrounding prose/comments, or when the file is not TypeScript/TSX.

Good runs usually look like `resolve -> def/context -> refs/graph -> targeted file read -> patch`. Bad runs look like `rg -> sed -> more sed` with symnav sprinkled in later. If you catch yourself searching for a symbol name with `rg`, stop and run `symnav resolve` or `symnav refs`.

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

## Task recipes

**Fix a failing test**

1. Run `symnav resolve <test name or failing symbol>`.
2. If the failing file is known, run `symnav overview <test-file> --depth 2` to see the test structure without reading the whole file.
3. Run `symnav context <implementation target>` for the code under test.
4. Run `symnav refs <implementation target> --all` when changing public behavior.

**Add or change an API**

1. Run `symnav resolve <API name>` to find the declaration.
2. Run `symnav def <target>` for the exact signature.
3. Run `symnav refs <target> --all` before editing.
4. Run `symnav graph <target> --incoming --depth 2` if the API is called through wrappers, adapters, routers, commands, plugins, or framework registration.

**Trace unfamiliar behavior**

1. Run `symnav resolve <verb or type name>`.
2. Run `symnav context <target>` for the best candidate.
3. If the context output says callers/callees overflow, run the suggested `symnav graph` command.
4. Use `overview --at` only after you know the file and need a specific nested block.

**Refactor safely**

1. Run `symnav refs <target> --all` before the first edit.
2. Run `symnav graph <target> --incoming --depth 2` for shared methods and exported helpers.
3. Patch the declaration and every reference class of call site the output shows.
4. Re-run `symnav refs` after the patch if the target still exists and should have fewer/no references.

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
