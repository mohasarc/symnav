---
name: symnav
description: Navigate TypeScript by symbol from the CLI — file symbol tree (overview), find a symbol (resolve), where it's defined (def), references (refs), local context (context), call paths (graph). Deterministic, project-wide, alongside normal reads, search, and edits.
---

`symnav` answers TypeScript navigation questions deterministically, project-wide: what's in a file, where a symbol is defined, who references it, how calls flow.

Reach for it at two moments, both worth it:

- **Orienting** — map a file, find where a symbol lives, understand it before editing, find an existing helper to reuse.
- **Confirming** — after a change, check the rename hit every site, the new symbol is referenced where it should be, callers still connect, blast radius matches expectation.

Run inside a git workspace. `--cwd <dir>` targets another workspace; `--json` gives machine output. Cold TypeScript start can yield early with empty output — that's not the result, wait for it. Warnings on stderr are non-fatal; exit 0 means stdout is the answer.

## Agent sandboxes

Codex and Claude Code sandboxes usually deny writes to symnav's state folder (`~/.symnav`). Then every command runs cold and stderr says `symnav: warning: cannot write <dir> (EPERM); daemon and telemetry are off for this command`. Stdout is still the answer.

**When you see that warning, you MUST fix it with setup before doing anything else. Do not jump to a workaround.**

1. Run setup yourself, then check it:

   ```
   symnav setup codex        # or: symnav setup claude-code
   symnav doctor codex
   ```

2. If setup fails (the sandbox often can't write its own config), stop and ask the user to run it, with the `!` prefix so it runs right there in the session:

   ```
   ! symnav setup codex
   ```

   Wait for their reply. Don't continue the task with a workaround while you wait.

3. After setup succeeds, ask the user to restart the agent session; the grant applies to new sessions.

### Last resort only

Use these only if the user declines setup, says it can't be done, or no human can answer (a non-interactive run). Never pick them yourself just to save a step.

- Point state at a folder the sandbox can already write — its temp folder, or a gitignored folder in the workspace. Prefix every symnav command with the same value; shells often don't keep exports between commands: `SYMNAV_STATE_DIR="$TMPDIR/symnav-state" symnav refs charge`. Its daemon and stats are separate from the host's `~/.symnav`, and a wiped temp folder means cold again.
- `SYMNAV_DAEMON=0 SYMNAV_TELEMETRY=0` never touches state and stays quiet, but is always cold.

## Commands

| Need | Command | Gives |
| --- | --- | --- |
| File map | `overview <file>` | symbol/fold tree for one `.ts`/`.tsx`. `--depth` nests; `--at '<text>'` selects a symbol, test block, or region — an exact symbol path or header beats longer substring matches |
| Find a symbol | `resolve <query>` | every symbol/file matching the name; an empty exact result names `--fuzzy`/`--regex` as the retry |
| Declaration | `def <target>` | file, line range, signature |
| Use sites | `refs <target>` | every reference, grouped by file, tagged by kind, paginated |
| Local blast radius | `context <target>` | definition + direct callers + callees + reference summary + git history |
| Call paths | `graph <target>` | multi-hop incoming/outgoing call paths |

`context` counts statically-resolved workspace calls, capped at 20 per direction; overflow points to `graph`. `graph` covers multi-hop and possible/dynamic edges.

## Targets

`resolve` searches by name and lists candidates. `def`/`refs`/`context`/`graph` take a **target** — a unique suffix of the canonical id:

```
charge
orders.ts::charge
src/orders.ts::PaymentProcessor::charge
```

- Use workspace-relative paths: `src/orders.ts::charge`, not `/app/src/orders.ts::charge`.
- One target per command.
- Quote targets containing `$ * [ ] ( ) !` or spaces in single quotes.
- Naming a file pins the whole symbol path: `orders.ts::charge` finds top-level `charge`, never `orders.ts::PaymentProcessor::charge`. Drop the file part to reach nested symbols.
- Ambiguous target → symnav prints candidates; copy one and retry.
- Not found → check the path is workspace-relative and the name appears in `overview`/`resolve`.

`--regex` switches the target to a case-sensitive JS regex over full canonical ids:

```
symnav def --regex 'PaymentProcessor::charge$'
symnav refs --regex 'src/payments/.+::charge$'
symnav graph --regex 'Router::dispatch#[1-3]$'
```

Anchor with `$` — an unanchored regex matches anywhere in the id and goes ambiguous fast.

## Options

- `overview` — `--depth <n>`, `--at <text>`, `--line <n>`
- `resolve` — `--fuzzy` (subsequence), `--regex` (JS regex; not with `--fuzzy`)
- `def`/`refs`/`context`/`graph` — `--regex` (JS regex target), `--line <n>`
- `refs` — `--page <n>`, `--page-size <n>`, `--all`, `--full-lines`
- `graph` — `--incoming`, `--outgoing`, `--depth <n>`, `--page <n>`, `--page-size <n>`, `--all`
- all — `--json`
