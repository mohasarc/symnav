---
name: symnav-resolve-graph
description: Use `symnav resolve` and `symnav graph` for deterministic TypeScript symbol navigation in this benchmark arm.
---

`symnav resolve` and `symnav graph` commands are installed globally.

```
symnav resolve ...
symnav graph ...
```

Use normal reads, search, tests, and edits whenever they help.

## `resolve`

`resolve` lists symbols and files whose names match a query.

```
$ symnav resolve 'queryClient'
$ symnav resolve 'QueryObserver'
$ symnav resolve --regex 'create.*Persister'
```

Pass one query per command. Use `--regex` for JavaScript regular expression matching. The output lists candidates; copy a precise candidate when you need to refer to a specific symbol elsewhere in normal code inspection.

## `graph`

`graph` prints multi-hop incoming or outgoing call paths around a unique symbol target.

```
$ symnav graph src/orders.ts::charge --incoming --depth 2
$ symnav graph src/orders.ts::charge --outgoing --depth 3
$ symnav graph src/orders.ts::charge --incoming --depth 2 --all
```

Use workspace-relative file paths in targets. Write `src/orders.ts::charge`, not `/app/src/orders.ts::charge`. `--incoming` follows callers. `--outgoing` follows callees. `--depth` controls hop count. Use `--page`, `--page-size`, or `--all` for larger graphs.

If `graph` says a target is ambiguous, choose the printed candidate that matches the symbol you need and retry with that exact candidate string. If it says no symbol target was found, re-check that the file path is workspace-relative and that the symbol name appears in prior output.
