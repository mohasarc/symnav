# symnav

`symnav` answers code navigation questions deterministically, project-wide: what's in a file, where a symbol is defined, who references it, how calls flow. When it answers the question, use it instead of a read or a search, not on top of one.

- **Orient** with it before opening files. `overview <file>` instead of reading the whole file, `overview <file> --at '<name>'` for one part. `def --source <target>` instead of `sed -n`, `cat`, or a line-range read. `resolve <name>` or `refs <target>` instead of grepping for a name.
- **Before the first edit**, run `refs` or `context` on what you plan to change, so callers and blast radius are known up front. `graph` follows calls past one hop.
- **Confirm** after the edit with the same commands: the rename hit every site, the new symbol is referenced where it should be, callers still connect.

Fall back to reads and grep for files symnav can't read and for text that isn't a symbol, like strings, config, or comments.

Run each symnav call on its own or join calls with `;`. `Cannot answer: …` exits 1, so in `symnav refs charge && git diff` the `git diff` never runs.

A cold call on a big repo can take most of a minute. If your shell yields the call or shows no output yet, keep polling the same session until it exits. An empty poll is not the answer. Don't rerun the call or switch to grep while it runs. If it exits with no output, fall back to reads.

Command guide below.
