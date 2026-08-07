---
name: symnav-graph
description: Use `symnav graph` for deterministic TypeScript symbol navigation in this benchmark arm.
---

`symnav graph` command is installed globally.

```
symnav graph ...
```

Use normal reads, search, tests, and edits whenever they help.

## `graph`

`graph` prints multi-hop incoming or outgoing call paths around a unique symbol target.

```
$ symnav graph src/orders.ts::charge --incoming --depth 2
$ symnav graph src/orders.ts::charge --outgoing --depth 3
$ symnav graph src/orders.ts::charge --incoming --depth 2 --all
```

Use workspace-relative file paths in targets. Write `src/orders.ts::charge`, not `/app/src/orders.ts::charge`. `--incoming` follows callers. `--outgoing` follows callees. `--depth` controls hop count. Use `--page`, `--page-size`, or `--all` for larger graphs.

If `graph` says a target is ambiguous, choose the printed candidate that matches the symbol you need and retry with that exact candidate string. If it says no symbol target was found, re-check that the file path is workspace-relative and that the symbol name appears in prior output.
