---
description: How to structure, split, and write commits — message format, granularity, special commits, branching, and history rewriting rules
alwaysApply: true
---

# Commits

How to structure and write commits. Applies to all commit history, planned or ad-hoc.

## Granularity (THE MOST IMPORTANT PART)

- One logical change per commit. If the description needs "and", split
- Don't move and change at the same time: pure move commit, then edits
- Don't introduce a type and use it at the same time: type commit, then first use. Types only — never stubs or placeholder implementations. Shared types with multiple consumers especially get their own preceding commit
- Don't refactor and add behavior at the same time: refactor first, behavior on top
- Order commits as a story the reviewer reads top-down: foundation type → refactor existing users onto it → data layer → state → component → page rework → wiring → interaction state. Foundation before consumer, leaf component before its composite
- Supporting material (test helpers, small utils) lands right before its first consumer, not at the front of the branch
- One exported function per commit, even within the same file
- A file gaining several distinct behaviors gets one commit per behavior, even though they all touch the same file
- A function with independent concerns grows across commits: one concern per commit, each with everything that concern needs to work
- Supporting assets (styles, localization strings, config entries) land in the commit that introduces what references them, never before. Unrelated blocks split even when they share a file
- Cosmetic changes to existing elements go in their own commit, never mixed with logic
- Every commit builds; red test commits are the exception — tests only, failing only from their own not-yet-existing imports
- TDD is per behavior, not per batch: commit only the failing tests for ONE behavior, then the commit that turns them green, then repeat for the next behavior. Never one huge test commit fixed across the next N commits. A red commit holds test/story files only — no stubs, no shells, no wiring; whatever's needed to compile belongs to the green commit

## Messages

- keep messages concise. Add a body when the change is weird, confusing, or unusual. Everything else (general rationale, root cause narrative) belongs in the PR description
- Be specific and plain — name real symbols: "Rename getUserData to fetchUserProfile", not "Rename function" or invented vocabulary
