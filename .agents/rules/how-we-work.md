---
description: PR workflow, stacking with gh stack, and media uploads.
alwaysApply: true
---

- All work lands through a PR
- Stack PRs with `gh stack` (`init`, `add`, `submit`, `sync`)
- Upload images and video with `--attach` on `gh pr create`, `gh pr edit`, and `gh pr comment`
- Prefer worktrees
- Update docs and examples in the same PR when behavior changes
- Before opening or pushing to a PR, run the same steps CI runs, from a clean tree with a frozen-lockfile install. Anything less is not verified
