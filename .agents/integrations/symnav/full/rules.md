# Full symnav integration

Using `symnav` is required for this task, and using it *well* matters. Reach for it ahead of grep, find, and plain file reads for any question about the TypeScript code. It is not just an orientation tool — use it to reuse existing code, trace call flow, and understand a symbol's blast radius. Prefer it over the usual tools and lean on it hard.

Make strong, deliberate use of it:
- **Map top-down, then zoom.** Start with `symnav overview <file> --depth 0` for the high-level shape, then expand only the part you care about with `--depth 1/2` or `--at '<symbol>'`. Don't hand-dump a file with `sed`/`cat` when overview already covers it.
- **Follow the call graph — this is underused and high-value.** `symnav graph '<file>::<symbol>' --incoming --depth 2` shows who calls it (what your change will affect); `--outgoing --depth 2` shows what it calls (the pipeline you plug into). Widen with `--depth`. Run graph before editing shared code and whenever you need to understand how calls flow.
- **Grab a symbol's neighborhood in one shot.** `symnav context '<file>::<symbol>'` returns its definition, direct callers, direct callees, and a reference summary — the fastest way to understand a symbol before editing it.
- **Find code to reuse.** `symnav resolve '<name>'` locates existing symbols, helpers, regexes, and idioms across the project — reuse the existing one instead of writing a new parser or utility.
- **See every use site.** `symnav refs '<file>::<symbol>'` lists all references grouped by file — use it to find reuse opportunities and to see everything that depends on code you are about to change.
- **Jump to a declaration.** `symnav def '<file>::<symbol>'` prints the exact location and signature of a symbol.

Sequences that work well (examples, not requirements): `overview` → `context` to understand a site; `overview` → `graph --incoming/--outgoing` to trace call flow; `resolve` → `graph` to find a symbol then map its callers/callees. Use symnav early to orient, mid-task to locate and understand symbols, and before editing shared code to see what depends on it.

Known caveat: `symnav` is extremely slow. A single call can take 10 to 20 minutes. That is expected — run it anyway and wait for it to finish. Do not treat a long-running call as stuck, and do not skip it to save time. Time is not what we care about here.

Its full command guide is included below in this file.
