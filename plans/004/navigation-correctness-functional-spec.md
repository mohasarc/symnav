# Navigation Correctness and Target Matching Functional Spec

## Goal

This work makes existing symnav navigation commands choose better targets, report the real reason a target failed, and attribute calls to the declaration that contains them. It also gives `def`, `refs`, `context`, and `graph` the same explicit regex matching option already familiar from `resolve`. This is a correction and extension of existing navigation behavior, not a new navigation command. This spec defines product behavior only and avoids implementation choices.

## Primary User

The first-class user is a coding agent navigating an unfamiliar workspace.

Default commands stay concise, deterministic, and non-interactive. Exact and suffix target matching remain the default. Regex matching requires an explicit `--regex` flag. JSON remains available through `--json`.

## Core Guarantees

### One suffix, one match

A regular symbol target matches a candidate when the candidate canonical id ends with the target at a path or segment boundary. Symnav resolves the target when exactly one candidate matches, and reports ambiguity when several do.

Functional rule:

```text
A candidate matches when its canonical id ends with the target.
Boundaries are path separators and "::" separators, never mid-name.
Two or more matches are ambiguous.
```

Example:

```text
Target: orders.ts::charge

Candidates:
- src/adapters/orders.ts::charge
- src/domain/orders.ts::PaymentProcessor::charge

Result:
src/adapters/orders.ts::charge
```

Only the first candidate ends with `orders.ts::charge`. The second ends with `PaymentProcessor::charge`, so the target does not reach its file portion.

A shorter target trades precision for reach. `charge` alone ends both canonical ids above, so it is ambiguous and symnav prints both. Lengthen the target until one candidate remains.

Symnav does not rank matches by specificity, source order, or an arbitrary first result. There is no first-result override.

### Line filtering reports what happened

Symbol matching happens before `--line` narrowing. An error distinguishes a target that never matched from one whose matches were removed by the line filter.

Functional rule:

```text
No matches before line filtering means the target was not found.
Matches before line filtering and no matches after it means the target does not match the requested line.
```

Example:

```console
$ symnav def helper --line 99
Cannot answer: no symbol target "helper" matching line 99.
```

This rule applies whether the target initially matched one symbol or several symbols.

### Regex changes syntax, not target scope

On symbol commands, regex matching searches the same canonical symbol IDs addressed by regular targets. Regex does not switch to source-text search.

Functional rule:

```text
Symbol-command regexes are tested against full canonical symbol IDs.
Regex matching is case-sensitive.
```

Example canonical IDs:

```text
src/adapters/orders.ts::charge
src/domain/orders.ts::PaymentProcessor::charge
```

Example:

```console
$ symnav def --regex 'charge$'
```

Both IDs match.

Example:

```console
$ symnav def --regex 'orders\.ts::charge$'
```

Only `src/adapters/orders.ts::charge` matches.

There is no case-insensitive regex option in this scope.

### Caller identity follows execution scope

Calls inside a function-valued initializer are attributed to the declaration whose body contains the call. They are never attributed to an unrelated declaration because it appears earlier in the file.

Functional rule:

```text
Context callers and graph incoming paths name the declaration that contains the executed call.
```

Example: a file declares `foldedRoot`, then later declares a top-level function-valued variable named `foldedHost`. The initializer body declares and calls `foldedNested`. For `foldedNested`, both `context` callers and `graph --incoming` identify `foldedHost`, not `foldedRoot`.

## Scope

### Included

- Strongest-match selection for regular symbol targets.
- Case-sensitive `--regex` on `def`, `refs`, `context`, and `graph`.
- Regex matching against full canonical symbol IDs.
- Shared regex validation behavior across commands that accept regex patterns.
- `--line` errors that distinguish missing targets from filtered-out matches.
- Consistent missing-file errors for file suffixes with or without directory separators.
- Symbol-target vocabulary for malformed target input.
- Recovery guidance after ambiguous symbol-target results.
- Correct caller attribution for calls inside function-valued initializers.
- Recovery guidance after an empty exact `resolve` result.
- Exact-label preference for `overview --at`.

### Excluded

- Case-insensitive regex matching or an ignore-case flag.
- Fuzzy matching on `def`, `refs`, `context`, or `graph`.
- A selector for identical overview folds on the same source line.
- Enclosing-symbol ownership in reference payloads.
- Nesting reference output under enclosing symbols.
- Fold-node-specific errors from symbol commands.
- Changes to what `resolve --regex` searches.
- New navigation commands.

## Existing Skipped Acceptance Baseline

This scope includes 28 currently skipped end-to-end cases. Every case below must be re-enabled and pass. Test names may be updated to describe final behavior.

Passing these cases is a minimum acceptance baseline. It does not replace new unit, integration, regression, or edge-case coverage needed to prove each behavior.

| Existing test                                                                                                                                                           |  Cases |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| [`target-patterns.test.ts`](../../apps/cli/test/e2e/target-patterns/target-patterns.test.ts): `%s resolves a file suffix plus full segment path to the one exact match` |      4 |
| [`target-patterns.test.ts`](../../apps/cli/test/e2e/target-patterns/target-patterns.test.ts): `%s rejects a regex target matching several symbols`                      |      4 |
| [`target-patterns.test.ts`](../../apps/cli/test/e2e/target-patterns/target-patterns.test.ts): `%s separates a line-filtered target from a never-matched one`            |      4 |
| [`target-patterns.test.ts`](../../apps/cli/test/e2e/target-patterns/target-patterns.test.ts): `%s reports an empty segment as a target-pattern error`                   |      4 |
| [`target-patterns.test.ts`](../../apps/cli/test/e2e/target-patterns/target-patterns.test.ts): `%s reports a slashless missing-file suffix like a slashed one`           |      4 |
| [`target-patterns.test.ts`](../../apps/cli/test/e2e/target-patterns/target-patterns.test.ts): `%s points at the way out of an ambiguous target`                         |      4 |
| [`context.test.ts`](../../apps/cli/test/e2e/context/context.test.ts): `attributes a call in a variable-initializer body to that initializer`                            |      1 |
| [`graph.test.ts`](../../apps/cli/test/e2e/graph/graph.test.ts): `names the enclosing initializer as the incoming caller`                                                |      1 |
| [`resolve.test.ts`](../../apps/cli/test/e2e/resolve/resolve.test.ts): `names the broader matching modes on an empty exact result`                                       |      1 |
| [`overview-targeting.test.ts`](../../apps/cli/test/e2e/overview/overview-targeting.test.ts): `targets a class by its bare name`                                         |      1 |
| **Total**                                                                                                                                                               | **28** |

## Interaction Model

### Regular symbol targets

`def`, `refs`, `context`, and `graph` continue to accept one suffix target:

```console
$ symnav def charge
$ symnav refs orders.ts::PaymentProcessor::charge
$ symnav context src/domain/orders.ts::PaymentProcessor::charge
```

Canonical IDs retain this shape:

```text
<workspace-relative-file>::<symbol-path>
```

Regular targets remain structured suffix targets. They are not regular expressions unless `--regex` is present.

### Regex symbol targets

The same four commands accept `--regex`:

```console
$ symnav def --regex 'PaymentProcessor::charge$'
$ symnav refs --regex 'src/domain/.+::charge$'
$ symnav context --regex '::build[A-Z][^:]*$'
$ symnav graph --regex 'Router::dispatch#[1-3]$'
```

The positional target is interpreted as a regex pattern over full canonical IDs. Canonical overload disambiguators are part of the matched ID.

`--line` may narrow regex matches in the same way it narrows regular target matches.

### Overview targets

`overview --at` remains substring-based:

```console
$ symnav overview class-with-methods.ts --at Greeter --depth 1
```

When one candidate's displayed label equals the supplied text and other candidates only contain it, the exact label wins. If several exact labels remain, result is ambiguous. If no exact label exists, normal substring matching applies.

`--line` remains a narrowing filter for overview candidates.

## Output and Error Format

Existing command result formats remain unchanged except for the guidance and corrected errors in this spec.

### Ambiguous symbol targets

Ambiguity output lists deterministic, copyable canonical IDs. It ends with guidance that users can copy a candidate ID or narrow with `--line`.

Example:

```text
Cannot answer: symbol target "PaymentProcessor::charge" is ambiguous.

Candidates
├── src/domain/invoices.ts::PaymentProcessor::charge
└── src/domain/orders.ts::PaymentProcessor::charge

Copy a candidate id, or narrow with --line.
```

Regex matches use the same ambiguity format when more than one candidate remains.

### Invalid regular targets

Malformed regular targets use symbol-target vocabulary:

```console
$ symnav def ::charge
Cannot answer: invalid symbol target (empty path segment between "::" separators): "::charge".
```

They do not use the retired `invalid symbol id` wording.

### Invalid regex patterns

Every command accepting `--regex` applies the same validation rules and uses the same error vocabulary. Error output includes the rejected pattern and the reason it is invalid.

### Missing files

A target containing a file suffix that matches no workspace file reports that file as missing, whether or not suffix contains a directory separator.

```console
$ symnav def missing.ts::charge
Cannot answer: file not found: missing.ts.
```

```console
$ symnav def src/missing.ts::charge
Cannot answer: file not found: src/missing.ts.
```

If file exists but its symbol path does not match, symnav reports a missing symbol target instead.

## Cross-cutting Behavior

### Determinism

Candidate matching, ambiguity order, and error output are deterministic for same workspace and request.

### Matching order

For symbol commands, request processing follows this observable order:

```text
1. Match regular target or regex against canonical IDs.
2. Apply --line when present.
3. Return one winner, not-found, line-mismatch, or ambiguity.
```

Regular targets and regexes reach this order the same way. Every surviving match has equal standing.

### Exit behavior

Successful navigation writes result to stdout and exits successfully. Invalid regexes, missing files, missing targets, line mismatches, and ambiguity write `Cannot answer:` output to stderr and exit as user-facing errors.

## Correct Caller Attribution

**Purpose.** Keep `context` and incoming `graph` paths tied to actual containing declaration.

For a nested declaration called from a top-level function-valued initializer, `context` lists initializer declaration as caller. `graph --incoming` uses same identity in incoming path.

This feature does not add reference ownership to `refs`. It affects call relationships only.

## Symbol Target Matching

**Purpose.** Resolve a regular suffix target when exactly one canonical id ends with it.

A candidate matches when its canonical id ends with the target at a boundary. Several matches remain ambiguous.

Example:

```console
$ symnav def orders.ts::charge
```

This selects `src/adapters/orders.ts::charge`. Nested `src/domain/orders.ts::PaymentProcessor::charge` does not end with the target.

Example:

```console
$ symnav def PaymentProcessor::charge
```

If two files contain that exact symbol path, command remains ambiguous.

## Symbol Target Regex

**Purpose.** Let users address symbol families with explicit patterns before choosing or narrowing one result.

`def`, `refs`, `context`, and `graph` accept case-sensitive regex patterns over full canonical IDs. Zero matches produce not-found. One match runs command. Multiple matches produce normal candidate ambiguity. `--line` can narrow matches.

Regex matching does not search source text, signatures, previews, or file contents.

## Symbol Target Errors

**Purpose.** Tell user whether request was malformed, missing, line-filtered, or ambiguous, and provide next action.

Errors use target vocabulary consistently. File-looking suffixes are validated consistently. Ambiguity output tells user how to continue.

This feature does not diagnose fold headers passed to symbol commands.

## Empty Exact Resolve Guidance

**Purpose.** Give user a next step when exact name lookup returns nothing.

When exact `resolve` returns no symbols and no files, text output names broader matching modes:

```text
No exact match; try --fuzzy for approximate names, or --regex for a pattern.
```

The command still exits successfully because an empty resolve result is not an error.

The hint does not appear when exact mode returns any symbol or file. This scope does not add new hints to empty fuzzy or regex results.

JSON output remains structured result data and does not add prose guidance.

## Exact Overview Target Preference

**Purpose.** Let a short exact label select its node without being shadowed by longer labels containing same text.

Example candidates:

```text
Greeter
Greeter::greet
Greeter::shout
```

Example request:

```console
$ symnav overview class-with-methods.ts --at Greeter --depth 1
```

The class `Greeter` is selected because its label is exact. Members are rendered as requested children, not treated as competing target matches.

If no label exactly equals `--at` text, substring behavior remains unchanged.

## Summary

- Caller attribution names declaration that contains executed call.
- Regular symbol targets prefer full paths over weaker suffix matches.
- `def`, `refs`, `context`, and `graph` accept case-sensitive regex over canonical IDs.
- Line-filtered, malformed, missing-file, and ambiguous requests explain actual failure.
- Empty exact `resolve` output suggests fuzzy and regex modes.
- `overview --at` prefers exact labels before substring candidates.
