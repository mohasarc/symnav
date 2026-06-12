# Symnav Functional Spec

## Goal

Build an agent-first code discovery CLI that feels clean enough for a human to read directly. The tool should replace semantic misuse of text search, not replace `rg` for plain text search.

This spec defines product behavior only. It intentionally avoids implementation technology choices.

## First-Class User

The first-class user is an agent.

Agents should still receive clean, human-readable output by default. JSON is optional, not the default.

Default output should be:

- concise
- deterministic
- non-interactive
- readable in a terminal
- formatted with Unicode tree characters
- free of machine-oriented noise unless requested

Structured output can exist behind:

```bash
--json
```

## Core Guarantees

### Current Results Only

The tool must never return stale navigation results.

Functional rule:

```text
All answers reflect the current workspace at command execution time.
```

If the tool cannot produce current results, it fails instead of returning stale data.

Example:

```text
Cannot answer: current navigation data unavailable.
```

There is no stale-data override.

### Ignored Files

All commands operate only on non-ignored workspace files.

Rules:

- Project ignore files define the boundary.
- Ignored files are always out of scope.
- There are no built-in ignore rules beyond project ignore behavior.
- There is no include-ignored override.
- The tool does not mention ignored files unless the user directly queries an ignored path.

Example:

```text
Cannot answer: path is ignored by project rules.
```

### Ambiguity

When input is ambiguous, the tool stops and shows candidates.

It must not guess or recommend one candidate as the likely intended answer.

Example:

```text
Ambiguous symbol: processPayment

Candidates
├── src/checkout/CheckoutService.ts
│   └── 42-78: CheckoutService::processPayment
│       async processPayment(...)
└── src/payments/PaymentProcessor.ts
    └── 18-31: PaymentProcessor::processPayment
        async processPayment(...)
```

## V1 Commands

V1 includes:

```text
resolve
def
refs
overview
context
graph
```

V1 excludes:

```text
impact
history
diff
impls
search-text
```

## Input Model

V1 command inputs are semantic. Line numbers and line ranges are output metadata only; they are not accepted as command targets.

`resolve` accepts a name or query:

```bash
symnav resolve PaymentProcessor
symnav resolve --fuzzy payment
```

`overview` accepts a file path:

```bash
symnav overview src/checkout/CheckoutService.ts
```

Symbol commands accept canonical symbol IDs:

```bash
symnav def src/checkout/CheckoutService.ts::CheckoutService::processPayment
symnav refs src/checkout/CheckoutService.ts::CheckoutService::processPayment
symnav context src/checkout/CheckoutService.ts::CheckoutService::processPayment
symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment
```

Canonical symbol IDs use this shape:

```text
<file-path>::<symbol-path>
```

Human-readable output does not repeat canonical IDs when they can be derived. When a symbol is shown under a file path, its canonical ID is `<file-path>::<symbol-path>`.

The shown symbol path must include any disambiguator needed to reconstruct a valid canonical ID.

Examples:

```text
src/checkout/CheckoutService.ts
└── 42-78: CheckoutService::processPayment
    async processPayment(order: Order): Promise<Receipt>

Canonical ID:
src/checkout/CheckoutService.ts::CheckoutService::processPayment
```

```text
src/http/Router.ts
├── 40: Router::post#overload1
│   post(path: string, handler: Handler): void
├── 44: Router::post#overload2
│   post(path: RegExp, handler: Handler): void
└── 48-62: Router::post#implementation
    post(path: string | RegExp, handler: Handler) { ... }
```

Exact/default input should not silently fuzzy-match.

## Output Grammar

Human-readable output uses Unicode tree characters.

There is no ASCII fallback requirement.

Reference-like lines use this shape:

```text
<line>: <preview>  [<kind-or-metadata>]
```

Example:

```text
└── 58: await checkoutService.processPayment(order)  [usage]
```

Metadata is shown as a bracket tag after the source preview.

Symbol-like lines use this shape:

```text
<line-range>: <symbol-path>
<signature-or-declaration>
```

When output is shown in a terminal, matched symbols may be highlighted with ANSI styling. When output is piped, no highlight markers or extra characters are emitted.

## Pagination

Large result sets are paginated.

Common flags:

```bash
--page <n>
--page-size <n>
--all
```

Default page size:

```text
100
```

Pagination must be stable:

```text
For the same workspace state and same query, page 2 contains the same results every time.
```

Sorting rules for reference-style output:

```text
1. file path
2. line number within each file
```

## `resolve`

Purpose:

```text
Find matching symbols and files for a provided name.
```

`resolve` returns symbols and files in separate sections.

It does not include arbitrary text/string matches.

Example:

```bash
symnav resolve --fuzzy Payment
```

```text
Resolve: Payment

Symbols
├── src/checkout/CheckoutService.ts
│   ├── 8: MAX_PAYMENT_RETRIES
│   │   const MAX_PAYMENT_RETRIES: number
│   └── 42-78: CheckoutService::processPayment
│       async processPayment(order: Order): Promise<Receipt>
├── src/payments/PaymentProvider.ts
│   └── 2-5: PaymentProvider
│       interface PaymentProvider
├── src/payments/PaymentProcessor.ts
│   ├── 8-64: PaymentProcessor
│   │   class PaymentProcessor
│   └── 22-36: PaymentProcessor::charge
│       static async charge(order: Order): Promise<Payment>
└── src/payments/types.ts
    ├── 1: PaymentStatus
    │   type PaymentStatus = "pending" | "paid" | "failed"
    └── 6-10: PaymentMethod
        enum PaymentMethod

Files
(none)
```

The Files section excludes any file already present in the Symbols section. Only files whose basename matches the query and that contain no matching symbol appear here.

## `def`

Purpose:

```text
Show where a symbol is defined.
```

`def` returns:

- implementation, when one exists
- declarations
- overload signatures
- multiple implementations when the queried symbol represents a contract/base symbol

`def` never returns usages.

Example:

```text
Definition: Router::post

src/http/Router.ts
├── 40: Router::post#1  [overload]
│   post(path: string, handler: Handler): void
├── 44: Router::post#2  [overload]
│   post(path: RegExp, handler: Handler): void
└── 48-62: Router::post#3  [implementation]
    post(path: string | RegExp, handler: Handler): void
```

When a name collides with siblings in the same scope, each colliding symbol carries a numeric disambiguator (`#1`, `#2`, …) assigned in source order. The query may include or omit the disambiguator: with it, exactly that symbol matches; without it, every same-name sibling matches.

Example with multiple implementations:

```text
Definition: PaymentProvider::charge

src/payments/PaymentProvider.ts
└── 2: PaymentProvider::charge  [declaration]
    charge(): Promise<void>

src/payments/StripeProvider.ts
└── 10-18: StripeProvider::charge  [implementation]
    charge(): Promise<void>

src/payments/PaypalProvider.ts
└── 10-18: PaypalProvider::charge  [implementation]
    charge(): Promise<void>
```

## `refs`

Purpose:

```text
Show all references to a symbol, excluding the symbol's own definition/declaration.
```

`refs` should not hide import/export/type references. It shows everything within non-ignored workspace files, except the symbol's own definition/declaration.

Default output is a compact Unicode filesystem tree.

Directory chains with only one child should collapse.

Files and line entries remain separate levels, even when a file has only one reference.

Example:

```text
References: PaymentProcessor
Total: 6
Kinds: usage 3, import 2, export 1
Page: 1/1
Sort: path, line

src/
├── checkout/CheckoutService.ts
│   ├── 3: import { PaymentProcessor } from "../payments/PaymentProcessor"  [import]
│   └── 44: const receipt = await PaymentProcessor.charge(order)  [usage]
├── payments/
│   ├── index.ts
│   │   └── 2: export { PaymentProcessor } from "./PaymentProcessor"  [export]
│   └── RefundService.ts
│       ├── 6: import { PaymentProcessor } from "./PaymentProcessor"  [import]
│       └── 29: await PaymentProcessor.refund(paymentId)  [usage]
└── tests/payments/PaymentProcessor.test.ts
    └── 18: expect(await PaymentProcessor.charge(order)).toEqual(receipt)  [usage]
```

Preview rules:

- one preview line by default
- trim long lines by default
- preserve the matched symbol in the trimmed preview when possible
- full lines can be requested explicitly

Example:

```bash
symnav refs src/payments/PaymentProcessor.ts::PaymentProcessor --full-lines
```

## `overview`

Purpose:

```text
Show the symbol structure of a file.
```

`overview` replaces the earlier `symbols` command name.

`overview` shows:

- private/local symbols
- signatures
- line ranges
- nested symbol hierarchy

Default depth:

```text
all
```

Example:

```text
Overview: src/checkout/CheckoutService.ts

8: MAX_RETRY_ATTEMPTS
8: const MAX_RETRY_ATTEMPTS: number

12-96: CheckoutService
12: class CheckoutService
├── 24-34: CheckoutService::constructor
│   24: constructor(paymentProcessor: PaymentProcessor, inventory: InventoryService)
├── 42-78: CheckoutService::processPayment
│   42: async processPayment(order: Order): Promise<Receipt>
└── 80-94: CheckoutService::validateOrder
    80: private validateOrder(order: Order): void

98-112: createReceipt
98: function createReceipt(order: Order, payment: Payment): Receipt
```

Each signature line is prefixed with its source line number; a multi-line signature renders one numbered line per source line.

## `context`

Purpose:

```text
Show compact context around a symbol without dumping full reference output.
```

`context` includes:

- definition
- direct callers with previews
- direct callees with previews
- reference summary
- recent history summary

`context` does not include:

- full refs output
- mini graph
- full diffs
- full function bodies by default
- separate top signature for now

Sections with no results should be shown in `context`.

Example:

```text
Context: CheckoutService::processPayment
File: src/checkout/CheckoutService.ts
Lines: 42-78

Definition
src/checkout/CheckoutService.ts
└── 42-78: CheckoutService::processPayment  [implementation]
    async processPayment(order: Order): Promise<Receipt>

Callers
src/api/CheckoutController.ts
└── 58-72: CheckoutController::submitOrder  [call]
    return checkoutService.processPayment(order)

Callees
src/payments/PaymentProcessor.ts
├── 22-36: PaymentProcessor::charge  [call]
│   static async charge(order: Order): Promise<Payment>
└── 47-55: PaymentProcessor::recordReceipt  [call]
    static async recordReceipt(receipt: Receipt): Promise<void>

References
Total: 8
Kinds: call 3, import 2, test 3
Run: symnav refs src/checkout/CheckoutService.ts::CheckoutService::processPayment

Recent History
1. abc123f 2026-04-12 Alice
   add retry handling to payment processing

2. def456a 2026-03-29 Bob
   move checkout flow into CheckoutService
```

Callers/callees in `context`:

- use filesystem tree format
- show direct callers/callees only
- include one preview line
- are capped by default

Default cap:

```text
20 callers
20 callees
```

If more exist, output should point to `graph`.

## `graph`

Purpose:

```text
Show relationships around a symbol.
```

`graph` is the only v1 relationship-graph command. There is no separate `impact` command.

Defaults:

```text
Depth: 1
Direction: both
Edges: calls
```

Maximum depth:

```text
5
```

If a requested depth exceeds max, the tool refuses and explains how to continue from leaves.

Example:

```text
Cannot run graph with depth 12.
Maximum supported depth is 5.

To continue exploration:
1. Run with depth 5.
2. Pick a leaf symbol from the output.
3. Run graph again from that symbol.
```

No graph presets in v1.

Explicit flags:

```bash
symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment
symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment --incoming
symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment --outgoing
symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment --depth 2
```

Graph nodes are shown under file paths with line ranges, symbol paths, and signatures when available.

```text
<line-range>: <symbol-path>
<signature>
```

Graph shows symbol nodes only. It does not show source preview lines.

Root stays at the top for both incoming and outgoing sections.

Example:

```text
Graph: CheckoutService::processPayment
File: src/checkout/CheckoutService.ts
Lines: 42-78
Depth: 2
Direction: both
Edges: calls

Incoming
src/checkout/CheckoutService.ts
└── 42-78: CheckoutService::processPayment
    async processPayment(order: Order): Promise<Receipt>
    └── src/api/CheckoutController.ts
        └── 58-72: CheckoutController::submitOrder  [caller]
            submitOrder(req: Request): Promise<Response>
            └── src/api/routes.ts
                └── 14-20: registerCheckoutRoutes  [caller]
                    function registerCheckoutRoutes(router: Router): void

Outgoing
src/checkout/CheckoutService.ts
└── 42-78: CheckoutService::processPayment
    async processPayment(order: Order): Promise<Receipt>
    ├── src/payments/PaymentProcessor.ts
    │   └── 22-36: PaymentProcessor::charge  [callee]
    │       static async charge(order: Order): Promise<Payment>
    │       └── src/payments/GatewayClient.ts
    │           └── 31-46: GatewayClient::capture  [callee]
    │               capture(payment: Payment): Promise<CaptureResult>
    └── src/orders/OrderRepository.ts
        └── 65-81: OrderRepository::markPaid  [callee]
            markPaid(orderId: string): Promise<void>
            └── src/database/Database.ts
                └── 18-34: Database::transaction  [callee]
                    transaction<T>(callback: TransactionCallback<T>): Promise<T>
```

Possible/low-confidence edges are included by default but labeled inline.

Example:

```text
Graph: SomeHandler::handle
File: src/handlers/SomeHandler.ts
Lines: 12-40
Depth: 1
Direction: both
Edges: calls

Incoming
src/handlers/SomeHandler.ts
└── 12-40: SomeHandler::handle
    handle(action: string): Promise<void>
    ├── src/callers/DirectCaller.ts
    │   └── 27-36: DirectCaller::callThing  [caller]
    │       callThing(): Promise<void>
    └── src/routing/DynamicRouter.ts
        └── 44-58: DynamicRouter::dispatch  [possible: dynamic property access]
            dispatch(action: string): Promise<void>

Outgoing
src/handlers/SomeHandler.ts
└── 12-40: SomeHandler::handle
    handle(action: string): Promise<void>
    ├── src/services/KnownService.ts
    │   └── 18-26: KnownService::run  [callee]
    │       run(): Promise<void>
    └── src/handlers/HandlerRegistry.ts
        └── 33-48: HandlerRegistry::dispatchAction  [possible: dynamic property access]
            dispatchAction(action: string): Promise<void>
```

Repeated symbols are not hidden if they appear through different paths. Path information matters.

If repetition is significant, include a compact note:

```text
Note: 3 symbols appear in multiple paths.
```

Graph pagination is path-based.

For the same workspace state, query, direction, depth, and page settings, graph pages must contain the same paths in the same order every time.

Graph output should prioritize shorter paths before deeper paths. When paths are otherwise equivalent, sort by canonical symbol ID.

Default graph page size:

```text
100 paths
```

Depth and pagination are separate:

```bash
symnav graph src/checkout/CheckoutService.ts::CheckoutService::processPayment --depth 3 --page-size 100
```

This means:

```text
Explore up to 3 hops.
Show the first 100 resulting paths.
```

## Final V1 Command Summary

```text
resolve
Find matching symbols/files for a user-provided name.

def
Show where a symbol is defined, including implementation/declarations/overloads when relevant.

refs
Show all references to a symbol, excluding its own definition/declaration.

overview
Show the symbol hierarchy inside a file with signatures and line ranges.

context
Show compact symbol context: definition, direct callers/callees, reference summary, and recent history summary.

graph
Show a configurable call relationship graph around a symbol.
```
