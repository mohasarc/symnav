---
name: symnav-context
description: Use `symnav context` for deterministic TypeScript symbol navigation in this benchmark arm.
---

`symnav context` command is installed globally.

```
symnav context ...
```

Use normal reads, search, tests, and edits whenever they help.

## `context`

`context` prints one block around a symbol: definition, direct callers, direct callees, reference summary, and recent git history.

```
$ symnav context src/orders.ts::charge
$ symnav context src/orders.ts::PaymentProcessor::charge
```

Targets are suffix patterns and must identify one workspace symbol. Use workspace-relative file paths in targets. Write `src/orders.ts::charge`, not `/app/src/orders.ts::charge`. `context` reports direct statically resolved callers and callees in workspace files.

If `context` says a target is ambiguous, choose the printed candidate that matches the symbol you need and retry with that exact candidate string. If it says no symbol target was found, re-check that the file path is workspace-relative and that the symbol name appears in prior output.
