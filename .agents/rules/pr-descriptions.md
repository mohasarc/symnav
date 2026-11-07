---
description: How to write PR descriptions. Read before opening a PR or editing its description.
alwaysApply: true
---

# PR descriptions

- Write it with the describe-work skill
- Cover this PR only. Skip stack position and what comes before or after
- Skip any section that would be empty or restate the title
- One concrete fact per sentence or bullet. "validates input order", not "improves robustness"
- References: the issue it closes or is part of, little else
- UI changes include before/after images or video. Look at every image before posting. It must show the change, not an empty page

# PR titles

The repo squash-merges, so the PR title becomes the commit on `main` and release-please reads it to pick the version bump. The `pr-title` check enforces the format.

- Format: `<type>[!]: <Imperative capitalized subject naming real symbols>`, e.g. `feat: Add regex targets`
- No scopes. `feat(cli): ...` fails the check
- `!` after the type marks a breaking change, bumps major
- Types:
  - `feat` new user-facing behavior, bumps minor
  - `fix` bug fix, bumps patch
  - `perf` faster, same behavior, bumps patch
  - `docs`, `chore`, `refactor`, `test`, `ci`, `build` no release on their own
