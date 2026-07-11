---
name: symnav-refs
description: Use `symnav refs` for deterministic TypeScript symbol navigation in this benchmark arm.
---

`symnav refs` command is installed globally.

```
symnav refs ...
```

Use normal reads, search, tests, and edits whenever they help.

## `refs`

`refs` lists workspace references to a unique symbol target, grouped by file.

```
$ symnav refs src/orders.ts::charge
$ symnav refs src/orders.ts::charge --all
$ symnav refs src/orders.ts::charge --page 2 --page-size 50
```

Targets are suffix patterns. Use workspace-relative file paths in targets. Write `src/orders.ts::charge`, not `/app/src/orders.ts::charge`. Use `--all` for one complete listing, or page through large result sets. `--full-lines` prints untrimmed source previews.

If `refs` says a target is ambiguous, choose the printed candidate that matches the symbol you need and retry with that exact candidate string. If it says no symbol target was found, re-check that the file path is workspace-relative and that the symbol name appears in prior output.
