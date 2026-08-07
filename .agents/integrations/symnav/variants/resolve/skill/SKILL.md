---
name: symnav-resolve
description: Use `symnav resolve` for deterministic TypeScript symbol navigation in this benchmark arm.
---

`symnav resolve` command is installed globally.

```
symnav resolve ...
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
