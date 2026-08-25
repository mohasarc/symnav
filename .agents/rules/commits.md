---
description: How to structure, split, and write commits — message format, granularity, special commits, branching, and history rewriting rules
alwaysApply: true
---

# Commits

How to structure and write commits. Applies to all commit history, planned or ad-hoc.

## Granularity (THE MOST IMPORTANT PART)

- One logical change per commit. If the description needs "and", split
- Don't move and change at the same time: pure move commit, then edits
- Don't introduce a type and use it at the same time: type commit, then first use. Shared types with multiple consumers especially get their own preceding commit
- Don't refactor and add behavior at the same time: refactor first, behavior on top
- Foundation before consumer, leaf component before its composite
- One exported function per commit, even within the same file
- A file gaining several distinct behaviors gets one commit per behavior, even though they all touch the same file
- A function with independent concerns grows across commits: one concern per commit, each with its helper, branch, styles, and i18n together
- Styles land in the commit that introduces their class names, never before. Unrelated style blocks split even when they share a file
- Cosmetic changes to existing elements go in their own commit, never mixed with logic
- Every commit builds
- TDD is per behavior, not per batch: commit only the failing tests for ONE behavior, then the commit that turns them green, then repeat for the next behavior. Never one huge test commit fixed across the next N commits

## Messages

- Imperative title, no type prefix (`feat:`, `fix:`, `test:`)
- Title-only by default, keep messages concise. Add a body only when the change is weird, confusing, or unusual — then state why it was done. Everything else (general rationale, root cause narrative) belongs in the PR description
- Be specific: "Rename getUserData to fetchUserProfile", not "Rename function"
- Review-fix commits: title plus link to the GitHub comment as body

## Special commits

- Patch notes (`PatchNoteData.ts`): always a separate commit titled `pn`, never folded into another commit
- Supplementary design/analysis docs stay local and untracked; the PR holds only the fix

## Branching

- Never commit on `development`, `staging`, or `master`. Branch `mo/<kebab-slug>` from pulled `development` first
- One fix per branch/PR
