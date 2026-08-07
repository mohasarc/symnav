# def symnav integration

Using `symnav def` is required for this task, and using it *well* matters. Reach for it ahead of grep, find, and plain file reads for any question about the TypeScript code. It is not just an orientation tool — use it to reuse existing code, trace call flow, and understand a symbol's blast radius. Prefer it over the usual tools and lean on it hard.

Make strong, deliberate use of it:
- **Jump to a declaration.** `symnav def '<file>::<symbol>'` prints the exact location and signature of a symbol.

Use it early to orient, mid-task to locate and understand symbols, and before editing shared code.

Known caveat: `symnav def` is extremely slow. A single call can take 10 to 20 minutes. That is expected — run it anyway and wait for it to finish. Do not treat a long-running call as stuck, and do not skip it to save time. Time is not what we care about here.

Its full command guide is included below in this file.
