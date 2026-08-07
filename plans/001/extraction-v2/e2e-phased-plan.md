# Extraction V2 E2E Coverage Plan

This plan adds end-to-end coverage for the user-facing behavior delivered by extraction-v2 phases 1-8. It does not replace unit or integration tests that already own backend details. E2E tests here prove command wiring, fixture workspace behavior, renderer output, stdout/stderr routing, JSON shape, help text, and cross-command target resolution.

Use existing e2e conventions:

- Tests live under `apps/cli/test/e2e/`.
- Fixtures live under `packages/testing/fixtures/`.
- Tests call `runSymnavBinary` from `@symnav/testing`.
- Fixture roots come from `fixturePath("name")`.
- Git-backed fixtures call `ensureFixtureGitMarker` in `beforeAll`.
- Snapshots are used for stable multi-line output. Focused assertions are used for small permutations.

Verification for every implementation PR:

```bash
pnpm test && pnpm lint && pnpm typecheck
```

## Phase 1 - Diagnostics And Input Errors

Goal: prove unsupported extraction warnings are non-fatal and input-file errors route to the expected stream.

### Test files

- Extend `apps/cli/test/e2e/overview/unsupported-input.test.ts`.
- Add `apps/cli/test/e2e/extraction-diagnostics/extraction-diagnostics.test.ts`.
- Add snapshots under `apps/cli/test/e2e/extraction-diagnostics/__snapshots__/`.

### Fixtures

- Extend `packages/testing/fixtures/overview-cases/`:
  - `extensionless` with TypeScript-looking content.
  - `unsupported.md`.
  - `src/rules/` directory already used by existing test; keep it.
- Add `packages/testing/fixtures/extraction-v2-cases/`:
  - `package.json`.
  - `dot-git/HEAD`.
  - `src/known-ignored-namespace-export.ts`:
    - `export as namespace katex;`
    - `export function render(): void {}`
  - `src/unsupported-statement.ts`:
    - Use the same unsupported statement kind covered by backend extraction diagnostics unit tests.
    - Include `export function stillVisible(): string { return "ok"; }`.
  - `src/unsupported-member.ts`:
    - Use the same unsupported class/member kind covered by backend diagnostics unit tests.
    - Include one supported sibling method.

### Behavior matrix

| Command | Fixture | Expected |
| --- | --- | --- |
| `overview src/rules` | `overview-cases` | exit 1, stdout empty, stderr exactly `Cannot answer: src/rules is a directory; expected a TypeScript source file.` |
| `overview extensionless` | `overview-cases` | exit 1, stdout empty, stderr names `extensionless` and says expected TypeScript source file |
| `overview unsupported.md` | `overview-cases` | exit 1, stdout empty, stderr names unsupported extension |
| `overview src/known-ignored-namespace-export.ts` | `extraction-v2-cases` | exit 0, stderr empty, stdout includes `render`, stdout excludes namespace export diagnostic |
| `overview src/unsupported-statement.ts` | `extraction-v2-cases` | exit 0, stdout includes `stillVisible`, stderr contains one warning with file path and line |
| `overview src/unsupported-statement.ts --json` | `extraction-v2-cases` | exit 0, stderr contains same warning, stdout parses as JSON and includes supported entry |
| `resolve stillVisible` | `extraction-v2-cases` | exit 0, stderr contains same warning once, stdout includes candidate |
| `def stillVisible` | `extraction-v2-cases` | exit 0, stderr contains same warning once, stdout includes definition |
| `refs stillVisible` | `extraction-v2-cases` | exit 0, stderr contains same warning once, stdout remains refs output |
| `context stillVisible` | `extraction-v2-cases` | exit 0, stderr contains same warning once, stdout includes context sections |
| `graph stillVisible` | `extraction-v2-cases` | exit 0, stderr contains same warning once, stdout includes graph sections |

### Assertions

- Warnings are written to stderr before normal stdout is asserted.
- Successful warning cases keep exit status `0`.
- User errors keep stdout empty and exit status `1`.
- Unsupported diagnostics are de-duplicated by diagnostic key per command result.
- Known ignored syntax produces no stderr.

### Commit plan

1. `test(e2e): cover extraction diagnostics routing`
2. `test(e2e): cover overview source input errors`

## Phase 2 - Collapsed Headers And Default Overview

Goal: cover phase 2 and phase 4 renderer behavior at the CLI boundary without duplicating backend header tables.

### Test files

- Extend `apps/cli/test/e2e/overview/fold-tree.test.ts`.
- Add `apps/cli/test/e2e/overview/collapsed-headers.test.ts`.
- Add snapshots under `apps/cli/test/e2e/overview/__snapshots__/`.

### Fixtures

- Extend `packages/testing/fixtures/overview-cases/`:
  - `collapsed-headers.ts` with `leakyFunction`, `HeaderService`, `HeaderContract`, `HeaderAlias`, `HeaderMode`, `HeaderNamespace`, overloads, `arrowHelper`, `functionHelper`, `schema`, `values`, and `callResult`.
  - `collapsed-headers.ts` includes JSDoc, function body, class body, interface, type alias, enum, namespace, overloads, accessor, constructor, arrow-function variable, function-expression variable, object literal, array literal, and call-expression initializer.
  - `collapsed-headers.ts` includes `callsLeakyFunction()` so refs/context have one real call site.
  - `default-fold-overview.ts` with top-level symbols, member symbols, top-level calls, `if`, loops, switch, try/catch/finally, bare block, nested callback, and nested declarations.
  - `barrel.ts` already exists; extend only if named, namespace, and star re-export permutations are not all present.

### Behavior matrix

| Command | Expected |
| --- | --- |
| `overview collapsed-headers.ts` | no JSDoc text, no function body statements, no object/array initializer body dump |
| `overview collapsed-headers.ts --json` | every entry header line is collapsed; JSON uses discriminated node types |
| `overview default-fold-overview.ts` | default depth shows symbol children and fold headers, not fold interiors |
| `overview default-fold-overview.ts --depth 1` | opens one fold interior and shows nested declarations one level down |
| `overview barrel.ts` | renders `export *`, `export { A }`, and `export * as ns` edges without inlining target symbols |
| `def collapsed-headers.ts::leakyFunction` | definition signature excludes JSDoc/body leakage |
| `context collapsed-headers.ts::leakyFunction` | definition and callees/callers previews use collapsed headers where rendered |
| `refs collapsed-headers.ts::leakyFunction` | reference preview for `callsLeakyFunction` is present; declaration body does not appear as a reference |

### Assertions

- Negative assertions cover representative leaked body strings: `return`, `throw`, object property internals, array elements, and JSDoc text.
- Positive assertions cover useful header heads: `const helper = () => ...`, `const schema = z.object(...)`, `class Service`, `interface Contract`, overload signatures.
- Default overview shows fold headers for all fold kinds implemented by phase 4.
- Re-export edges appear as user-visible overview nodes and do not load target declarations.

### Commit plan

1. `test(e2e): cover collapsed headers in command output`
2. `test(e2e): cover default fold overview permutations`

## Phase 3 - Overview Targeting And JSON Metadata

Goal: exhaust phase 5 user-facing overview expansion rules.

### Test files

- Extend `apps/cli/test/e2e/overview/overview-targeting.test.ts`.
- Extend `apps/cli/test/e2e/overview/minified-line-guard.test.ts`.
- Add snapshots under `apps/cli/test/e2e/overview/__snapshots__/` for candidate errors when full output is useful.

### Fixtures

- Extend `packages/testing/fixtures/overview-cases/targeted-expansion.ts`.
- Extend `packages/testing/fixtures/overview-cases/minified-line.ts`.
- Add `packages/testing/fixtures/overview-cases/line-narrowing.ts` with:
  - two same-header folds on different lines.
  - one same-line group with multiple fold nodes.
  - nested symbol children behind folds.

### Behavior matrix

| Command | Expected |
| --- | --- |
| `overview targeted-expansion.ts` | depth 0 shows copied headers and excludes fold internals |
| `overview targeted-expansion.ts --depth 1` | opens one fold level globally |
| `overview targeted-expansion.ts --depth 2` | opens nested fold level globally |
| `overview targeted-expansion.ts --at 'describe("cursor")' --depth 1` | returns only targeted fold with one interior level |
| `overview targeted-expansion.ts --at nested --depth 1` | targets nested fold by substring |
| `overview targeted-expansion.ts --at describe` | exit 1, stdout empty, stderr lists all matching candidates |
| `overview targeted-expansion.ts --at missing` | exit 1, stdout empty, stderr says no overview target matched |
| `overview line-narrowing.ts --line <unique line> --depth 1` | line narrows to one candidate and succeeds |
| `overview line-narrowing.ts --line <ambiguous line>` | exit 1, stderr says line matches multiple nodes and lists candidates |
| `overview line-narrowing.ts --line <line> --at <text>` | line plus header text narrows to unique node |
| `overview minified-line.ts --line 1` | same-line/minified guard rejects with candidate list |
| `overview minified-line.ts --at 'describe("beta")'` | same-line fold can be selected by header text |
| `overview targeted-expansion.ts --at 'describe("cursor")' --depth 1 --json` | JSON includes `request.depth`, `request.at`, and targeted entries only |

### Assertions

- Symbol children of rendered symbols do not consume depth.
- Fold interiors consume depth.
- `--line` is only a narrowing filter. It never silently picks innermost.
- Candidate errors include ranges and headers copied from rendered overview output.
- JSON request metadata is present for depth, at, and line permutations.
- Invalid depth and line values stay covered by existing tests; add `--line 1.5` if missing.

### Commit plan

1. `test(e2e): cover overview depth levels`
2. `test(e2e): cover overview target narrowing`
3. `test(e2e): cover overview JSON request metadata`

## Phase 4 - Nested Declarations Behind Folds

Goal: prove stable flattened declaration identities work end to end across every command.

### Test files

- Extend `apps/cli/test/e2e/overview/overview.test.ts`.
- Extend `apps/cli/test/e2e/resolve/resolve.test.ts`.
- Extend `apps/cli/test/e2e/def/def.test.ts`.
- Extend `apps/cli/test/e2e/refs/refs.test.ts`.
- Extend `apps/cli/test/e2e/context/context.test.ts`.
- Extend `apps/cli/test/e2e/graph/graph.test.ts`.

### Fixtures

- Use existing:
  - `packages/testing/fixtures/overview-cases/control-flow-declarations.ts`.
  - `packages/testing/fixtures/definition-cases/src/control-flow/LocalDeclarations.ts`.
  - `packages/testing/fixtures/refs-cases/src/control-flow/ControlFlowTarget.ts`.
  - `packages/testing/fixtures/refs-cases/src/control-flow/ControlFlowReferences.ts`.
  - `packages/testing/fixtures/context-cases/src/nested/transform.ts`.
- Add `packages/testing/fixtures/graph-cases/src/folded-symbols.ts` if graph does not already include a target declared behind a fold.

### Behavior matrix

| Command | Invocation | Expected |
| --- | --- | --- |
| `overview` | `overview control-flow-declarations.ts --depth 2` | fold nodes render, nested declarations render behind folds |
| `resolve` | `resolve insideIf` | candidate id is flattened as `outer::insideIf` and excludes fold names |
| `resolve` | `resolve <full folded id>` | full flattened id matches exact resolve |
| `def` | `def src/control-flow/LocalDeclarations.ts::outer::insideLoop` | definition succeeds and points at nested declaration |
| `refs` | `refs controlFlowTarget --json` | references nested inside branch, loop, and callback are listed |
| `context` | `context transform --json` | callers nested inside branch, loop, and callback are listed |
| `graph` | `graph <folded target> --outgoing --depth 2 --json` | folded declaration can be root and path ids stay flattened |

### Assertions

- Fold headers such as `if`, `for`, `describe`, and callback calls never appear in canonical identities.
- Same nested declaration ids are accepted by `resolve`, `def`, `refs`, `context`, and `graph`.
- JSON identities use only declaration segments.
- Text output includes enough file and line data to copy the canonical id from candidates.

### Commit plan

1. `test(e2e): cover folded declaration identity round trips`
2. `test(e2e): cover folded symbols in context and graph`

## Phase 5 - Suffix-Pattern Targets Across Symbol Commands

Goal: prove phase 6 target grammar is one shared CLI behavior for `def`, `refs`, `context`, and `graph`.

### Test files

- Add `apps/cli/test/e2e/target-patterns/target-patterns.test.ts`.
- Keep existing command-specific smoke tests in `def`, `refs`, `context`, and `graph`.
- Add snapshots under `apps/cli/test/e2e/target-patterns/__snapshots__/`.

### Fixtures

- Add `packages/testing/fixtures/target-pattern-cases/`:
  - `package.json`.
  - `dot-git/HEAD`.
  - `src/domain/orders.ts` with `PaymentProcessor::charge`, `PaymentProcessor::refund`, and a nested folded helper.
  - `src/domain/invoices.ts` with another `PaymentProcessor::charge`.
  - `src/adapters/orders.ts` with `charge`.
  - `src/unique/helper.ts` with unique `helper`.
  - `src/folded/folded.ts` with a `describe(...)` fold and declaration `insideFold`.
  - `src/calls.ts` with references and calls to the above targets for refs/context/graph assertions.

### Target matrix

Run the same target cases through each command where supported.

| Target | Expected |
| --- | --- |
| `helper` | unique bare name succeeds |
| `orders.ts::charge` | ambiguous if both domain and adapters basename suffixes match; stderr lists full ids |
| `domain/orders.ts::charge` | file suffix narrows to domain order charge |
| `PaymentProcessor::charge` | ambiguous across files with same segment suffix |
| `orders.ts::PaymentProcessor::charge` | unique segment suffix succeeds |
| `src/domain/orders.ts::PaymentProcessor::charge` | full id succeeds |
| `missing` | not-found error names raw pattern |
| `insideFold` | folded-symbol traversal succeeds |
| `describe("x")` or copied fold header | rejected as no symbol target; fold nodes are not targets |
| `<target> --line <declaration line>` | narrows to matching declaration |
| `<target> --line <non-matching line>` | not-found or ambiguity after line filter, with raw target named |

### Command matrix

| Command | Invocations | Expected assertions |
| --- | --- | --- |
| `def` | all target matrix rows, plus `--json` for one unique pattern | definition identity equals selected canonical id |
| `refs` | unique, file suffix, segment suffix, full id, ambiguous, not-found, folded target, `--line` | refs identity equals selected id; references sorted and not empty |
| `context` | unique, file suffix, segment suffix, full id, ambiguous, not-found, folded target, `--line` | context identity equals selected id; definition section present |
| `graph` | unique, file suffix, segment suffix, full id, ambiguous, not-found, folded target, `--line` | graph identity equals selected id; root path starts at selected id |

### Assertions

- Ambiguity output is byte-stable and lists canonical ids plus signatures.
- Not-found output names the raw target pattern.
- Full ids still work byte-for-byte for existing command snapshots where already covered.
- Former malformed ids are target patterns, not parser errors.
- Fold nodes are rejected because only declarations can be targets.
- `--line` is present in help for `def`, `refs`, `context`, and `graph`.

### Commit plan

1. `test(e2e): cover shared symbol target patterns`
2. `test(e2e): cover line narrowing for symbol targets`
3. `test(e2e): reject fold nodes as symbol targets`

## Phase 6 - Resolve Exact, Fuzzy, And Regex

Goal: exhaust phase 7 CLI behavior and guard exact/fuzzy regressions.

### Test files

- Extend `apps/cli/test/e2e/resolve/resolve.test.ts`.
- Extend `apps/cli/test/e2e/resolve/regex.test.ts`.
- Add snapshots under `apps/cli/test/e2e/resolve/__snapshots__/`.

### Fixtures

- Extend `packages/testing/fixtures/resolve-cases/src/converters.ts`.
- Add `packages/testing/fixtures/resolve-cases/src/full-id-regression.ts`:
  - file path and parent segment include `toOrder`.
  - own symbol name does not match `^to[A-Z]`.
- Add `packages/testing/fixtures/resolve-cases/src/exact-fuzzy-regression.ts`:
  - `PaymentProcessor`.
  - `PayProcessor`.
  - file basename match for `Payment.ts`.

### Behavior matrix

| Command | Expected |
| --- | --- |
| `resolve PaymentProcessor` | exact own-name match succeeds; fuzzy-only names excluded |
| `resolve paymentprocessor` | exact mode does not case/fuzzy match unless that is implemented deliberately |
| `resolve --fuzzy payment` | fuzzy symbol and file results remain covered |
| `resolve --regex '^to[A-Z].*'` | matches `toOrder`, `toReceipt` |
| `resolve --regex '^to[A-Z].*' --json` | JSON parses; matched symbol own names are exactly converter names |
| `resolve --regex 'toOrder'` | matches own-name `toOrder`; does not match symbols where only file or parent id contains `toOrder` |
| `resolve --regex '['` | exit 1, stdout empty, stderr says invalid regex and includes regex reason |
| `resolve --regex --fuzzy '^to[A-Z].*'` | exit 1, stdout empty, conflict error |
| `resolve --regex '^NoSuch'` | exit 0, stderr empty, empty symbol/file sections |

### Assertions

- Regex applies to own symbol name, not full canonical id.
- Regex mode does not search arbitrary text.
- `resolve` remains a listing command. It never auto-proceeds to definition.
- JSON continues to expose query and result arrays. If mode metadata is added later, assert it; otherwise keep current `fuzzy: false` regression.
- Help output includes `--regex` and does not mention regex on `def`, `refs`, `context`, or `graph`.

### Commit plan

1. `test(e2e): cover resolve regex errors`
2. `test(e2e): guard resolve matching modes`

## Phase 7 - Help And Documentation-Adjacent CLI Surface

Goal: cover changed help examples/options that are runtime CLI behavior. Do not add runtime tests for README or skill prose.

### Test files

- Add `apps/cli/test/e2e/help/help.test.ts`.

### Fixtures

- No fixture needed. Run from repo root or `trivial-project` only if command setup requires a workspace.

### Behavior matrix

| Command | Expected |
| --- | --- |
| `--help` | lists `overview`, `resolve`, `def`, `refs`, `context`, `graph` |
| `overview --help` | lists `--depth <n>`, `--at <text>`, `--line <n>`, `--json` |
| `resolve --help` | lists `--fuzzy`, `--regex`, `--json` |
| `def --help` | positional is `<target>`, lists `--line <n>` |
| `refs --help` | positional is `<target>`, lists `--line <n>`, pagination flags, `--full-lines` |
| `context --help` | positional is `<target>`, lists `--line <n>` |
| `graph --help` | positional is `<target>`, lists `--line <n>`, direction flags, depth, pagination |

### Assertions

- Help tests assert only stable command surface, not Commander spacing.
- README and `.agents/skills/symnav/SKILL.md` examples do not need e2e. They can be covered by meta/docs tests outside this plan if desired.

### Commit plan

1. `test(e2e): cover extraction v2 help surface`

## Phase 8 - Cross-Phase Smoke Matrix

Goal: add one compact e2e suite that proves the implemented permutations compose in one realistic project.

### Test files

- Add `apps/cli/test/e2e/extraction-v2/extraction-v2-smoke.test.ts`.
- Add snapshots under `apps/cli/test/e2e/extraction-v2/__snapshots__/`.

### Fixtures

- Add `packages/testing/fixtures/extraction-v2-cases/src/agent-workflow.ts`:
  - collapsed headers.
  - fold headers.
  - nested declaration behind fold.
  - re-export edge in sibling barrel file.
  - calls and references for context/graph.
  - one unsupported-but-non-fatal node from phase 1 diagnostics fixture.

### Workflow matrix

| Step | Command | Expected |
| --- | --- | --- |
| 1 | `overview src/agent-workflow.ts` | compact fold overview, no body/JSDoc leakage |
| 2 | `overview src/agent-workflow.ts --at '<copied header>' --depth 1` | targeted fold expansion |
| 3 | `resolve --regex '^build[A-Z]'` | finds own-name matches only |
| 4 | `def buildWorkflow` | bare target resolves if unique |
| 5 | `refs agent-workflow.ts::buildWorkflow --page-size 2` | suffix target resolves and paginates |
| 6 | `context buildWorkflow --json` | JSON identity and sections present |
| 7 | `graph buildWorkflow --outgoing --depth 2 --json` | graph identity and paths present |

### Assertions

- All successful commands exit `0`.
- Warning-producing fixture command writes diagnostics to stderr without corrupting stdout.
- Copied text from step 1 works in step 2.
- Copied target from ambiguity output works in `def`.
- JSON outputs parse after warning-free commands.
- Pagination and identity stay stable across repeated runs for one command.

### Commit plan

1. `test(e2e): add extraction v2 workflow smoke`

## Backlog

- Navigation diagnostics double the extraction cost per invocation: the post-compute sweep re-enumerates and re-parses the whole workspace with a fresh ts-morph project after the command's own resolution already parsed the files it needed. Accepted for phase 1; fold diagnostics into the backend navigation methods so the first parse surfaces them.
- Diagnostics only surface after a successful compute; `runCommand`'s error path skips them. When extraction skipped the very symbol a command targets, resolution fails and the relevant warning never prints. Needs e2e coverage plus a decision on surfacing diagnostics alongside command errors.

## Done when

- Every phase above has landed as its own focused PR or commit group.
- E2E coverage names every phase 1-8 user-facing behavior:
  - unsupported diagnostics and stdout/stderr routing.
  - directory, extensionless, and unsupported input errors.
  - collapsed headers in overview, def, refs, and context previews where user-visible.
  - default fold overview, fold nodes, re-export edges, and no body/JSDoc leakage.
  - nested declarations behind folds across overview, resolve, def, refs, context, and graph.
  - overview depth, `--at`, `--line`, ambiguity, not-found, same-line guards, and JSON request metadata.
  - suffix-pattern targets for def, refs, context, and graph, including bare names, file suffixes, segment suffixes, full ids, ambiguity, not-found, line narrowing, folded-symbol traversal, and fold-node rejection.
  - resolve exact, fuzzy, regex text, regex JSON, invalid regex, fuzzy/regex conflict, and own-name matching.
  - CLI help surface changed by extraction-v2.
- No source or test implementation is modified by this planning PR.
- Each implementation PR runs:

```bash
pnpm test && pnpm lint && pnpm typecheck
```
