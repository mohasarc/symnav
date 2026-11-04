---
description: Report anything that would make the next session better. Delegate to a subagent, never read the feedback file yourself.
alwaysApply: true
---

# Agent feedback

Report when a skill misleads you, a rule is wrong or missing, a doc is stale, or you keep repeating work a script could do. Some sessions report nothing, others a few.

Report only if a specific change would have saved the next session time. Skip one-off mistakes, product bugs, task TODOs, and secrets.

## Reporting

Spawn a background subagent on the cheapest model. Give it the brief below plus target, what happened, and proposed fix. Carry on without waiting for its result. Never read `.agents/feedback.md` yourself.

Target is one of `skill:<name>`, `rule:<name>`, `agents-md`, `script:<name>`, `automate`.

No subagent tool: append one table row to the file and carry on.

## Subagent brief

Only edit the feedback file. Don't act on the feedback.

1. Find the file, shared across worktrees, and clear a lock older than 2 minutes:
   ```bash
   FEEDBACK="$(git rev-parse --path-format=absolute --git-common-dir)/../.agents/feedback.md"
   find "$FEEDBACK.lock" -maxdepth 0 -mmin +2 -exec rmdir {} \; 2>/dev/null
   ```
2. Take the lock with `mkdir "$FEEDBACK.lock"`. If it fails, retry every couple of seconds for up to 30 seconds. Still locked: append one table row and stop.
3. Read the file, create it if missing, and update it:
   - Same issue already there: bump Count, update Last seen, add new detail to Notes
   - New issue: add a row
   - Keep one table, sorted by Count, highest first
   - Drop anything that fails the bar above
4. Release with `rmdir "$FEEDBACK.lock"`, even if the update failed.

File format, one row per issue. Escape a literal pipe as `\|`. Leave Notes empty when there's nothing to add:

```
| Count | Last seen  | Target           | Issue                                             | Fix                  | Notes                       |
| ----- | ---------- | ---------------- | ------------------------------------------------- | -------------------- | --------------------------- |
| 2     | 2026-11-04 | skill:work-to-prs | methods/commit-rules.md has drifted from repo rule | read repo rule only | reviewer checks both copies |
```
