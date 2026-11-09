---
name: symnav-overview
description: Use `symnav overview` for deterministic symbol navigation in this benchmark arm.
---

`symnav overview` command is installed globally.

```
symnav overview ...
```

Use normal reads, search, tests, and edits whenever they help.

Run each symnav call on its own or join calls with `;`. `Cannot answer: …` exits 1, so `&&` skips whatever comes after it.

## `overview`

`overview` prints a symbol and fold tree for one supported source file (today `.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs`).

```
$ symnav overview src/file.ts --depth 0
$ symnav overview src/file.ts --depth 1
$ symnav overview src/file.ts --depth 2
$ symnav overview src/file.ts --at 'class Example' --depth 2
```

Use a file path, not a directory. `--depth` controls nesting. `--at <text>` selects a matching symbol, class, function, test block, or fold header from the overview output.
