# Navigation

## Goal

Agent-first, language-agnostic code navigation by symbol that a human can also read directly. It replaces semantic misuse of text search.

## User

The main user is a coding agent. Output is still human-readable by default:

- concise, deterministic, non-interactive
- Unicode tree characters, no ASCII fallback
- no machine noise unless asked for

`--json` on every navigation command gives structured output instead.

## Core guarantees

### Current results only

Every answer reflects the workspace at the moment the command runs. There's no stale-data mode. This holds whether the command runs locally or through the workspace daemon: both routes give the same stdout, stderr, and exit code.

### Workspace scope

- The workspace is the nearest Git root at or above the current directory, or `--cwd <dir>`.
- `.gitignore` decides which files are in scope. Ignored files are never returned, and there's no include-ignored override.
- Nested Git repositories, worktrees, and submodules are separate workspaces. A parent workspace never traverses or returns their files.

```text
Cannot answer: ignored.ts is ignored by .gitignore.
Cannot answer: vendor/package/src/index.ts belongs to nested Git workspace rooted at /repo/vendor/package, not selected workspace /repo; run from /repo/vendor/package or use --cwd /repo/vendor/package.
Cannot answer: not in a git workspace (no .git found in or above /x).
Cannot answer: foo.ts is outside the workspace rooted at /repo.
Cannot answer: cannot read directory /repo/src/locked (EACCES).
```

### Ambiguity stops

When input matches more than one thing, symnav lists the candidates and stops. It never guesses, ranks, or picks a first result. There's no first-result override.

### Exit and streams

- Success: result on stdout, exit 0. An empty `resolve` or `refs` result is still success.
- User-facing failure: one `Cannot answer: …` message on stderr, exit 1, nothing on stdout.
- Warnings go to stderr as `symnav: warning: …` and never change stdout or the exit code. `--no-warnings` drops them.

## Commands

| Command            | Purpose                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `overview <file>`  | Symbol and fold tree of one file                                          |
| `resolve <query>`  | Find symbols and files by name                                            |
| `def <target>`     | Where a symbol is defined                                                 |
| `refs <target>`    | Every reference to a symbol                                               |
| `context <target>` | Definition, direct callers and callees, reference summary, recent history |
| `graph <target>`   | Multi-hop call paths                                                      |

Other commands, covered in [`daemon.md`](daemon.md): `daemon start|status|stop`, `setup <agent>`, `doctor [agent]`.

Global options: `--cwd <dir>`, `--no-warnings`, `-v/--version`. `--no-warnings` works in any argument position.

Usage telemetry is shape-only and on by default. Set `SYMNAV_TELEMETRY=0` to turn it off.

## Symbol targets

`def`, `refs`, `context`, and `graph` take one positional target. Line numbers are output only; they're never accepted as targets. `--line` narrows targets (see below).

### Canonical IDs

```text
<workspace-relative-file>::<symbol-path>
src/checkout/CheckoutService.ts::CheckoutService::processPayment
```

- Nested declarations add segments, e.g. `src/domain/orders.ts::PaymentProcessor::charge::formatCharge`.
- Folds (callbacks, control-flow blocks) are transparent and add no segment. A helper declared inside `describe("x", () => { … })` is `file.ts::helper`.
- Same-name siblings get a source-order disambiguator: `Router::post#1`, `Router::post#2`. A target without the disambiguator addresses the whole overload family.
- Output shows enough of the symbol path under its file to rebuild the canonical ID.

### Suffix matching (default)

A candidate matches when its canonical ID ends with the target at a `/` or `::` boundary, never mid-name. Exactly one match runs the command. Two or more is ambiguous.

```text
Candidates:
  src/adapters/orders.ts::charge
  src/domain/orders.ts::PaymentProcessor::charge

orders.ts::charge          → src/adapters/orders.ts::charge
domain/orders.ts::charge   → not found (doesn't reach past PaymentProcessor)
charge                     → ambiguous
```

A bare name and its full canonical ID print identical output when both resolve to the same symbol.

### `--regex`

Treats the target as a case-sensitive JavaScript regex over full canonical IDs, including disambiguators. It never searches source text, signatures, or previews. There's no case-insensitive option and no `--fuzzy` on symbol commands.

```sh
symnav def --regex 'PaymentProcessor::charge$'
symnav refs --regex 'src/domain/.+::charge$'
symnav graph --regex 'Router::dispatch#[1-3]$'
```

Zero matches is not-found, one runs, several is ambiguous.

### `--line <n>`

Applied after matching. Keeps only matches whose declaration contains line `n`. The error tells you which step removed everything.

### Order

1. Match target or regex against canonical IDs.
2. Apply `--line`.
3. Return one winner, not-found, line mismatch, or ambiguity.

### Target errors

```text
Cannot answer: no symbol target "src/hub.ts::missing" found.
Cannot answer: no symbol target "helper" matching line 99.
Cannot answer: file not found: missing.ts.
Cannot answer: invalid symbol target (empty path segment between "::" separators): "::charge".
Cannot answer: invalid regex "[": Unterminated character class.
```

A file part that matches no workspace file reports the file as missing, with or without a `/`, even when an ignored file ends with it. A file part that is the exact path of an ignored file reports `is ignored by .gitignore`, same as `overview`. A copied fold header is a plain not-found, since folds aren't symbols.

Ambiguity prints copyable IDs with signatures, plus the way out:

```text
Cannot answer: symbol target "PaymentProcessor::charge" is ambiguous.

Candidates
├── src/domain/invoices.ts::PaymentProcessor::charge
│   charge(amount: number, currency?: string): string
└── src/domain/orders.ts::PaymentProcessor::charge
    charge(amount: number): string

Copy a candidate id, or narrow with --line.
```

## Output grammar

Symbol lines:

```text
<line-range>: <symbol-path>  [<tag>]
    <signature>
```

Reference lines:

```text
<line>: <source preview>  [<kind>]
```

Tags go in brackets after the text. Signatures are collapsed headers: no JSDoc and no bodies. Function-valued initializers render as `const helper = () => …`.

## Pagination

`refs` and `graph` take `--page <n>`, `--page-size <n>` (default 100), and `--all`. For the same workspace state and query, every page is identical across runs.

## Extraction warnings

Known irrelevant syntax (e.g. `export as namespace x;`) is skipped silently. Syntax symnav doesn't recognize is skipped with one warning per kind and file, and the command still returns partial results. `--json` stdout stays parseable; warnings go to stderr.

## `overview`

```sh
symnav overview src/orders.ts
symnav overview src/orders.ts --depth 1
symnav overview src/orders.ts --at 'describe("cursor")' --depth 2
symnav overview src/orders.ts --line 14
```

Takes a file path, not a symbol target. Shows a VS Code-style fold tree: declarations, signatures, line ranges, barrel re-export lines, and fold headers for callbacks, calls, and control-flow blocks (`if`, `for`, `switch`, `try`, …).

- Default `--depth 0`: top-level entries only.
- `--depth n` opens `n` child levels. Class members, local declarations, and fold interiors each cost one level.
- `--at <text>`: substring match against node headers, as copied from earlier output. A node whose label equals the text exactly beats longer substring matches, so `--at Greeter` picks the class, not `Greeter::greet`. `--depth` then counts from that node.
- `--line <n>`: narrows candidates to nodes on that line. It can be combined with `--at`.
- Several candidates left means ambiguous, with candidates listed. There's no innermost-wins.
- Each signature line carries its source line number. Long headers are capped at 6 lines of 80 characters.

```text
Overview: class-with-methods.ts
└── 1-9: Greeter
    1 export class Greeter
    ├── 2-4: Greeter::greet
    │   2 greet(name: string): string
    └── 6-8: Greeter::shout
        6 shout(name: string): string
```

Folds at depth 1:

```text
Overview: targeted-expansion.ts
├── 1-3: describe("setup", () => {
│   └── 2: setupHelper
│       2 const setupHelper = () => 1
│
└── 13-18: action
    13 export function action(flag: boolean): void
    └── 14-17: if (flag) {
```

A file with no symbols prints `(no symbols)`. Errors:

```text
Cannot answer: file not found: missing.ts.
Cannot answer: src/rules is a directory; expected a source file.
Cannot answer: cannot read .json files (package.json).
Cannot answer: no overview target matching --at "missing".
Cannot answer: overview target matches multiple nodes.
Cannot answer: line 14 matches multiple overview nodes; use --at with copied header text.
```

## `resolve`

```sh
symnav resolve PaymentProvider
symnav resolve --fuzzy payment
symnav resolve --regex '^to[A-Z].*'
```

Finds symbols and files by name. It never returns text matches.

- Exact (default): case-sensitive match on a symbol's own name.
- `--fuzzy`: fuzzy subsequence match.
- `--regex`: JavaScript regex anchored to the whole own name, not the parent path. `--regex` with `--fuzzy` is an error.

Output has two sections. Files lists basename matches that aren't already shown under Symbols.

```text
Resolve: payment (fuzzy)

Symbols
├── src/checkout/CheckoutService.ts
│   ├── 1: MAX_PAYMENT_RETRIES
│   │   export const MAX_PAYMENT_RETRIES = 3
│   └── 8-10: CheckoutService::processPayment
│       async processPayment(orderId: string): Promise<string>
└── src/payments/PaymentProvider.ts
    └── 1-3: PaymentProvider
        export interface PaymentProvider

Files
└── src/Payment.ts
```

An empty exact result exits 0. Text output then adds `No exact match; try --fuzzy for approximate names, or --regex for a pattern.` JSON output gets no hint.

## `def`

Shows where a symbol is defined: the implementation, declarations, overload signatures, and every implementation of a contract or base member. It never shows usages.

```text
Definition: Router::post

src/http/Router.ts
├── 4: Router::post#1  [overload]
│   post(path: string, handler: Handler): void
├── 5: Router::post#2  [overload]
│   post(path: RegExp, handler: Handler): void
└── 6-9: Router::post#3  [implementation]
    post(path: string | RegExp, handler: Handler): void
```

```text
Definition: PaymentProvider::charge

src/payments/PaymentProvider.ts
└── 2: PaymentProvider::charge  [declaration]
    charge(orderId: string): Promise<string>

src/payments/StripeProvider.ts
└── 4-6: StripeProvider::charge  [implementation]
    async charge(orderId: string): Promise<string>
```

## `refs`

Every reference in non-ignored workspace files except the symbol's own declaration. Imports, exports, and type references are included. Kinds: `usage`, `import`, `export`, `type`.

Sorted by file path, then line. Single-child directory chains collapse. Files and lines are always separate levels.

```text
References: PaymentProcessor
Total: 14
Kinds: usage 7, import 5, export 1, type 1
Page: 1/5
Sort: path, line

src/
├── billing/RefundService.ts
│   ├── 1: import { PaymentProcessor } from "../payments";  [import]
│   └── 5: const processor = new PaymentProcessor();  [usage]
└── checkout/CheckoutService.ts
    └── 1: import { PaymentProcessor } from "../payments/PaymentProcessor";  [import]
```

Previews are one line, trimmed around the match. `--full-lines` prints them verbatim. Zero references prints the header with `Total: 0`.

## `context`

A compact picture of one symbol. Every section is always shown, `(none)` when empty.

- **Definition.**
- **Callers.** Direct only, with the call-site preview. `[call ×2]` marks repeated calls from one caller.
- **Callees.** Direct only, with their signature.
- **References.** Total and kinds, plus a `Run: symnav refs <id>` line.
- **Recent History.** Recent commits touching the symbol.

Callers and callees include only certain, statically resolved edges into workspace files, capped at 20 per direction. Overflow prints `… N more callers. Run: symnav graph <id> --incoming`. Possible or dynamic edges appear only in `graph`.

A call inside a function-valued initializer is attributed to the declaration whose body contains it, never to an earlier unrelated declaration. `graph --incoming` follows the same rule.

```text
Context: compute
File: src/math/calculator.ts
Lines: 3-7

Definition
src/math/calculator.ts
└── 3-7: compute  [implementation]
    export function compute(a: number, b: number): number

Callers
src/app/runner.ts
├── 3-5: runOnce  [call]
│     return compute(1, 2);
└── 7-11: runTwice  [call ×2]
      const first = compute(3, 4);

Callees
src/math/operations.ts
└── 1-3: add  [call]
    export function add(a: number, b: number): number

References
Total: 4
Kinds: usage 3, import 1
Run: symnav refs src/math/calculator.ts::compute

Recent History
1. 7828a8b 2023-04-25 Calc Bot
   name the scaled value
```

## `graph`

```sh
symnav graph <target>                # depth 1, both directions
symnav graph <target> --incoming     # callers only
symnav graph <target> --outgoing     # callees only
symnav graph <target> --depth 3 --page-size 50
```

Call edges only. Default depth 1, max 5. Depth and pagination are independent: `--depth 3 --page-size 50` explores 3 hops and shows the first 50 paths.

```text
Cannot run graph with depth 12.
Maximum supported depth is 5.

To continue exploration:
1. Run with depth 5.
2. Pick a leaf symbol from the output.
3. Run graph again from that symbol.
```

- Nodes show line range, symbol path, and signature. No source previews.
- The root sits on top of both the Incoming and Outgoing sections.
- Edges symnav can't statically confirm are still shown, labelled inline: `[possible: dynamic dispatch: exact callee not statically resolvable]`.
- A symbol reached by different paths shows on each one. When that happens: `Note: N symbols appear in multiple paths.`
- Paths are sorted shorter first, then by canonical ID along the path. Pages are stable.
- A contract member with several implementations is refused: `Cannot answer: symbol src/contract.ts::GraphShape::render matches multiple implementations: src/contract.ts::Box::render, src/contract.ts::Circle::render — query one directly.`

```text
Graph: dynamicRoot
File: src/dynamic.ts
Lines: 1-3
Depth: 2
Direction: outgoing
Edges: calls

Outgoing
src/dynamic.ts
└── 1-3: dynamicRoot
    export function dynamicRoot(kind: "alpha" | "beta"): number
    └── src/dynamic.ts
        ├── 10-12: dynamicAlpha  [possible: dynamic dispatch: exact callee not statically resolvable]
        │   export function dynamicAlpha(): number
        │   └── src/dynamic.ts
        │       └── 18-20: alphaLeaf  [callee]
        │           export function alphaLeaf(): number
        └── 14-16: dynamicBeta  [possible: dynamic dispatch: exact callee not statically resolvable]
            export function dynamicBeta(): number
```
