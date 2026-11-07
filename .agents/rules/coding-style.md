---
description: How to write code in this project — naming, structure, file boundaries, and test-first development.
alwaysApply: true
---

# Coding style

## TDD

Write the failing test first, then make it pass. Every behavior the code performs should have a test that would fail without it. Commit the red test as its own commit when the failure is informative; otherwise pair it with the implementation. The point is verified intent, not ceremony — small, focused tests that exercise real behavior beat broad tests that prove nothing.

## Rules

- Avoid comments — meaning comes from clear names. Comments never carry contracts, preconditions, or other load-bearing info; if it matters, encode it in types, names, or tests, where it can't silently rot during a refactor.
- Favor readable names, early returns, and simple control flow over clever code.
- Name what a value is, not the generic role it plays, so the name alone tells the reader its meaning. When related types share a member, lift it into a shared base so the commonality is expressed once.
- Spell out abbreviations in directory and file names — clarity for every future reader beats brevity once.
- Break large functions into smaller named ones; break long logic chains into named intermediate variables.
- Group functions into classes with explicit public/private/static members — a file of free functions calling each other is a violation, not a style choice. A function that is internal to a file and called only by other functions there belongs on the class as a private (static when stateless) member. A lone exported free function is acceptable only as a genuinely standalone helper with no in-file collaborators. Any shared or module-level state always lives in a class — never in module-scope variables. Share logic via abstract classes, not object literals.
- Define only what you need now when shaping interfaces — defer everything speculative.
- Don't invent preconditions on interfaces. Before stating "caller must do X", name the concrete failure mode if X is skipped. If nothing concretely breaks, the precondition is fictional — drop it, and don't smuggle one layer's responsibilities into another's surface.
- File boundaries follow architecture, not granularity. A file owns one cohesive unit — a class, an interface, a public function, or a small family of types that travel together — alongside the private helpers and types only it uses. Two failure modes to avoid: co-locating unrelated top-level abstractions in the same file, and shattering a coherent unit into one-function-per-file scaffolding. A helper that is used in exactly one place, has no independent meaning, and isn't tested on its own belongs inline with its caller; promote it to its own file once any of those changes.
- If a directory mixes files from two unrelated bounded contexts, split it — the listing should narrate what the package contains.
- Optimise filenames for the `ls`; optimise function names for the call site — they can disagree.
- Loose coupling beats DRY across module boundaries — do not deduplicate across independent modules.
- Prefer clear, small modules with explicit types at public boundaries.
- Reuse existing utilities before adding dependencies or new abstractions.
- No magic numbers. Extract literals into named constants (`MAX_RETRY_ATTEMPTS`).
- Extract multi-part `if` conditions into named booleans.
- More than one optional parameter goes in an options object.
- No side effects in ternaries, even wrapped in an arrow. Use `if` to choose between calls. Ternaries only pick values.
- Delete code and resources a change leaves unused.
- Keep terms used across the codebase. Suggest a rename before making one, don't invent new words.
- Keep CLI behavior deterministic, non-interactive by default, and covered by focused tests.
