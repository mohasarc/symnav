---
name: symnav
description: Navigate code by symbol from the CLI — file symbol tree (overview), find a symbol (resolve), where it's defined and its source (def), references (refs), local context (context), call paths (graph). Deterministic, project-wide. Use it instead of reading or grepping code when it answers the question.
---

`symnav` answers code navigation questions deterministically, project-wide: what's in a file, where a symbol is defined, who references it, how calls flow. When it answers the question, use it instead of a read or a search, not on top of one.

- **Orienting** — `overview <file>` instead of reading the whole file, `--at '<name>'` for one part. `def --source <target>` instead of `sed -n`, `cat`, or a line-range read. `resolve`/`refs` instead of grepping for a name. Also finds an existing helper to reuse.
- **Before the first edit** — `refs` or `context` on what you'll change, so callers and blast radius are known up front. `graph` for calls past one hop.
- **Confirming** — after a change, check the rename hit every site, the new symbol is referenced where it should be, callers still connect.

Reads and grep are still the tool for files symnav can't read and for text that isn't a symbol: strings, config, comments.

Run inside a git workspace. `--cwd <dir>` targets another workspace; `--json` gives machine output. Warnings on stderr are non-fatal; exit 0 means stdout is the answer.

Run each symnav call on its own or join calls with `;`. `Cannot answer: …` exits 1, so `&&` skips whatever comes after it.

A cold call on a big project can take a while. If your shell yields the call or shows no output yet, keep polling until it exits. An empty poll isn't the answer; don't rerun the call or switch to grep meanwhile.

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
| File map | `overview <file>` | symbol/fold tree for one supported file (today `.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs`). `--depth` nests; `--at '<text>'` selects a symbol, test block, or region — an exact symbol path or header wins, then a symbol's own name, then substring matches |
| Find a symbol | `resolve <query>` | every symbol/file matching the name; an empty exact result names `--fuzzy`/`--regex` as the retry |
| Declaration | `def <target>` | file, line range, signature; `--source` prints the numbered source lines instead of reading the file |
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
- Enum members are symbols under their enum: `Token::UsingKeyword`.
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

- `overview` — `--depth <n>`, `--at <text>`, `--line <n>`, `--all` (text is cut at 8000 chars by default; the footer says what was cut)
- `resolve` — `--fuzzy` (subsequence), `--regex` (JS regex; not with `--fuzzy`)
- `def`/`refs`/`context`/`graph` — `--regex` (JS regex target), `--line <n>`
- `def` — `--source` (each definition's source with line numbers; text is cut at 12000 chars and the footer names what was cut), `--all` (with `--source`, no cut)
- `refs` — `--page <n>`, `--page-size <n>`, `--all`, `--full-lines`
- `graph` — `--incoming`, `--outgoing`, `--depth <n>`, `--page <n>`, `--page-size <n>`, `--all`
- all — `--json`
