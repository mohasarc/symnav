---
name: symnav-overview-def
description: Use `symnav overview` and `symnav def` for deterministic TypeScript symbol navigation in this benchmark arm.
---

`symnav overview` and `symnav def` commands are installed globally.

```
symnav overview ...
symnav def ...
```

Use normal reads, search, tests, and edits whenever they help.

## `overview`

`overview` prints a symbol and fold tree for one TypeScript source file.

```
$ symnav overview src/file.ts --depth 0
$ symnav overview src/file.ts --depth 1
$ symnav overview src/file.ts --depth 2
$ symnav overview src/file.ts --at 'class Example' --depth 2
```

Use a `.ts` or `.tsx` file path, not a directory. `--depth` controls nesting. `--at <text>` selects a matching symbol, class, function, test block, or fold header from the overview output.

## `def`

`def` prints the declaration location and signature for a unique symbol target.

```
$ symnav def charge
$ symnav def orders.ts::charge
$ symnav def src/orders.ts::PaymentProcessor::charge
```

Targets are suffix patterns. A short name works when it is unique. If the target is ambiguous, `def` prints candidates; copy a more specific candidate from that output. Quote targets that contain shell-sensitive characters.

Use workspace-relative file paths in targets. Write `src/orders.ts::charge`, not `/app/src/orders.ts::charge`. If `def` says a target is ambiguous, choose the printed candidate that matches the symbol you need and retry with that exact candidate string. If it says no symbol target was found, re-check that the file path is workspace-relative and that the symbol name appears in prior output.
