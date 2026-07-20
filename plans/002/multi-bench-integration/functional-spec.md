# Multi-benchmark integration — functional spec

## 1. Goal

The benchmark workflow runs one fixed task suite (DeepSWE, 35 TypeScript tasks) through the stock-vs-symnav comparison. This adds **benchmark** as a selectable variable of a study, so a study can draw its tasks from a different source while every downstream artifact — attempts, trajectories, dashboard, analysis page, Pages publication — keeps the exact shape it has today. Two new benchmarks are integrated: **SWE-PolyBench** (TypeScript tasks, selectable by fit tier) and **Multi-SWE-bench** (its whole TypeScript set). The existing DeepSWE behavior is unchanged and becomes one benchmark among several. This spec defines product behavior only — what a study author selects and what the results look like — and avoids implementation choices.

## 2. Primary user

The study author (the person declaring and dispatching studies, and reading the resulting dashboard). Their default experience is unchanged: declare a study, dispatch it, read a stock-vs-symnav dashboard. The one new decision is **which benchmark** the study runs, and — for SWE-PolyBench only — **which fit tiers**. Everything they do after that is identical across benchmarks.

## 3. Core guarantees

### 3.1 Uniform artifact shape across benchmarks

Every artifact a study produces has the same shape regardless of which benchmark it ran. An attempt summary, a compact trajectory, a raw trajectory, `analysis.json`, the dashboard, and the Pages layout carry the same fields and the same meaning for DeepSWE, SWE-PolyBench, and Multi-SWE-bench. Reading a SWE-PolyBench dashboard requires learning nothing new.

```text
An attempt, trajectory, dashboard, and analysis.json produced by any integrated
benchmark are structurally identical to those produced by DeepSWE. Benchmark
identity is recorded as provenance; it never changes the schema of a result.
```

There is no benchmark-specific result format. A reader must not have to special-case a benchmark to interpret a score, an adoption number, or a trajectory step.

### 3.2 A study runs exactly one benchmark

A study pins one benchmark and one task selection within it. A study never mixes benchmarks, and there is no single dashboard that spans benchmarks.

```text
One study = one benchmark + one pinned task selection.
Comparing two benchmarks means comparing two studies, not reading one.
```

No-override: there is no dispatch flag that adds a second benchmark to an existing study.

### 3.3 Benchmark and task selection are pinned and immutable

The benchmark, the task selection (including SWE-PolyBench fit tiers), and the resolved task list are pinned into the study when it is declared, alongside the pins that already exist (agent/model/effort, conditions, repetitions, symnav revision, harness image, randomization seed). They are frozen for the life of the study.

```text
To run a different benchmark, a different tier set, or a different task subset,
declare a new study. An existing study's task universe cannot change.
```

No-override: there is no dispatch-time toggle for benchmark, tiers, or task subset. Changing any of them is a new study with a new identity.

### 3.4 Condition semantics are benchmark-independent

`stock` and `symnav` mean the same thing on every benchmark: stock runs the agent with no symnav; symnav injects the same symnav treatment (the pinned symnav revision's rules + skill). Because every integrated benchmark's tasks are TypeScript repositories, the symnav treatment applies unchanged.

```text
stock vs symnav is the same contrast on every benchmark. The treatment text and
tool access are identical; only the task source differs.
```

### 3.5 Deterministic, enumerable task set

A benchmark plus its pinned selection resolves to a fixed, listable set of tasks. The same study always plans the same tasks in the same order. The dashboard shows exactly that set — no sampling, no hidden tasks.

## 4. Scope

**Included**

- Benchmark as a pinned study variable, selectable per study.
- `deepswe` benchmark — existing 35 TypeScript tasks, unchanged, now addressed by name.
- `swe-polybench` benchmark — its TypeScript tasks, filterable by fit tier (high / mid / low). Default selection: high + mid.
- `multi-swe-bench` benchmark — its whole TypeScript set (all TypeScript repositories it ships), no tier filter.
- A per-task **fit tier** attribute for SWE-PolyBench, derived by a pinned rule and used only as a selection filter.
- Uniform normalization: every benchmark's pass/fail maps to the existing reward / f2p / p2p / partial result.
- Benchmark provenance recorded on every attempt and shown on the dashboard.
- Study naming that identifies the benchmark.

**Excluded**

- Any benchmark other than the three above — SWE-bench Multilingual, SWE-bench Multimodal, SWE-bench Pro, SWE-Lancer, Aider Polyglot are not integrated.
- Non-TypeScript tasks of any benchmark — SWE-PolyBench Java/JavaScript/Python and Multi-SWE-bench non-TypeScript languages are out.
- Fit-tier filtering for Multi-SWE-bench — it runs whole-TypeScript only.
- Repository-level filtering for SWE-PolyBench — only fit tier filters it, not repo.
- Multi-benchmark studies and any cross-benchmark single dashboard.
- Dispatch-time (mutable) task, tier, or benchmark selection.
- Any change to DeepSWE task set, DeepSWE scoring, conditions, repetitions, or the dashboard layout.

## 5. Interaction model

A study is addressed exactly as today — by study id, configuration id, and dispatch mode. The only additions are in what a study **declares**:

- **Benchmark** — one of `deepswe`, `swe-polybench`, `multi-swe-bench`.
- **Task selection** — benchmark-specific:
  - `deepswe`: none (all 35 TypeScript tasks).
  - `swe-polybench`: a fit-tier set, any non-empty subset of `high`, `mid`, `low`. Default `high, mid`.
  - `multi-swe-bench`: none (whole TypeScript set).

Study identifiers name the benchmark so a study is self-describing at a glance:

```text
deepswe-ts-codex-terra-medium-nudge-pr94              (unchanged, existing)
swe-polybench-ts-himid-codex-terra-medium-pr94        (high+mid tiers)
swe-polybench-ts-all-codex-terra-medium-pr94          (all three tiers)
multi-swe-bench-ts-codex-terra-medium-pr94            (whole TS)
```

Dispatch is unchanged: pick a study, a configuration, and a mode (run one batch, run all, or resume). No new dispatch parameters. What is **not** accepted: a benchmark, tier, or task argument at dispatch time — those live only in the study declaration.

Task identifiers keep each benchmark's native form and are shown verbatim:

```text
deepswe          drizzle-orm-window-function-builders
swe-polybench    microsoft__vscode-106767
multi-swe-bench  mui__material-ui-13082
```

## 6. Result format

Unchanged from today, for every benchmark. A study produces:

- **Attempt summaries** — one per (benchmark, configuration, condition, task, repetition), each carrying outcome, reward, f2p / p2p / partial diagnostics, usage, adoption, timing, and now **benchmark** and **task fit tier** (tier is present for SWE-PolyBench, empty otherwise) as provenance.
- **Compact and raw trajectories** — same step spine, tool calls, patches, verifier summary.
- **`analysis.json` and dashboard** — same tables, matrix, and per-task drill-down. The matrix rows are this study's task set; the columns are the same stock/symnav conditions. A benchmark label and, for SWE-PolyBench, a tier column appear as provenance.
- **Pages publication** — same URL structure and study switcher, with the benchmark-named study listed alongside existing ones.

```text
Score is still the mean binary reward over the repetitions per task, macro-averaged
across the study's tasks. f2p / p2p / partial remain internal diagnostics. The
number a reader sees means the same thing on every benchmark.
```

## 7. Cross-cutting concerns

- **Grading normalization.** Each benchmark verifies a solution with its own tests/harness, but the outcome is always reduced to the same binary `reward` plus f2p / p2p / partial. A reader never sees a benchmark-specific grade.
- **Conditions.** Always `stock` and `symnav`; four repetitions by default; identical to today.
- **Provenance.** Every attempt records its benchmark and (for SWE-PolyBench) its task fit tier, so a filtered dashboard can show which tier a task belongs to.
- **Determinism.** Same study → same task set, same order, same planned slots. The randomization seed governs trial ordering exactly as today.
- **Cost visibility.** A study's planned task count and slot count are stated at declaration and plan time, so the author sees the size before dispatch (e.g. SWE-PolyBench high+mid ≈ 179 tasks; all tiers ≈ 729 tasks; Multi-SWE-bench whole TS ≈ its full TypeScript instance count).
- **Empty selection.** A tier set that resolves to zero tasks is rejected at declaration, not dispatched.

## 8. Per-feature behavior

### 8.1 Benchmark selection

**Purpose.** Choose the task source a study runs.

**Produces.** A study bound to one benchmark, whose dashboard and trajectories cover only that benchmark.
**Does not produce.** A study spanning multiple benchmarks; a cross-benchmark comparison view.

**Default.** No implicit benchmark — a study must name one. Existing DeepSWE studies are read as `benchmark = deepswe`.

**Edge cases.** An unknown benchmark name is rejected at declaration. A benchmark named without a valid selection for that benchmark is rejected.

### 8.2 SWE-PolyBench integration

**Purpose.** Run SWE-PolyBench TypeScript tasks through stock-vs-symnav, scoped by fit tier.

**Produces.** A study over the SWE-PolyBench TypeScript tasks whose fit tier is in the pinned set. Each task shows its tier as provenance.
**Does not produce.** Non-TypeScript SWE-PolyBench tasks; repo-scoped selections; any task outside the pinned tiers.

**Fit tier definition.** Every SWE-PolyBench TypeScript task has exactly one fit tier, assigned by a pinned rule from the task's own change-shape metadata:

```text
LOW  — the change is a single function, a single class, or touches no code nodes.
HIGH — the change spans multiple loci: not single-function and not single-class,
       and (modified nodes >= 6 or function+class changes >= 4).
MID  — everything else.
```

The tier is a fixed property of a task, not a per-run choice; selecting tiers filters which tasks run.

**Default.** Fit tiers `high, mid` (the symnav-relevant breadth tasks). `low` is opt-in. Approximate sizes: high ≈ 116, mid ≈ 63, low ≈ 550 TypeScript tasks.

**Examples.**

```text
selection: tiers = [high, mid]     → ~179 tasks   (default)
selection: tiers = [high]          → ~116 tasks
selection: tiers = [high, mid, low]→ ~729 tasks   (whole TS)
```

**Edge cases.** An empty tier set is rejected. A tier naming anything other than high/mid/low is rejected. Task identity uses the SWE-PolyBench instance id verbatim (e.g. `microsoft__vscode-106767`).

### 8.3 Multi-SWE-bench integration

**Purpose.** Run the whole Multi-SWE-bench TypeScript set through stock-vs-symnav.

**Produces.** A study over every TypeScript task Multi-SWE-bench ships (its TypeScript repositories, e.g. `mui/material-ui`, `vuejs/core`, `darkreader/darkreader`).
**Does not produce.** A tier-filtered subset; non-TypeScript languages; a repo-scoped subset.

**Default.** Whole TypeScript set; no selection knobs. Rationale recorded in scope: the high-fit slice alone is too small to run in isolation, so the benchmark runs whole.

**Examples.**

```text
benchmark: multi-swe-bench, selection: (none) → all TypeScript tasks
```

**Edge cases.** Task identity uses the Multi-SWE-bench instance id verbatim. No tier column appears for these tasks (tier is empty provenance).

### 8.4 DeepSWE (baseline, unchanged)

**Purpose.** The existing 35-task TypeScript suite, now addressed as `benchmark = deepswe`.

**Produces.** Exactly what it produces today.
**Does not produce.** Any new selection knobs — DeepSWE has no tiers and no subsetting.

**Default.** All 35 TypeScript tasks. Existing studies keep their current identity and results.

### 8.5 Uniform results and analysis

**Purpose.** Guarantee every benchmark's study reads the same.

**Produces.** The same dashboard tables, matrix, per-task drill-down (all repetitions, retries, metrics, adoption, raw artifacts), study switcher, and Pages layout — populated with the selected benchmark's data, plus a benchmark label and (SWE-PolyBench) tier column.
**Does not produce.** A benchmark-specific chart, score, or layout.

**Edge cases.** A partial study (not all trials scored) is shown as provisional with coverage, exactly as today, independent of benchmark.

## 9. Summary

- **Benchmark selection** — a study pins exactly one benchmark; comparing benchmarks means comparing studies.
- **SWE-PolyBench** — TypeScript tasks filterable by fit tier (high/mid/low); default high+mid; tiers pinned at declaration.
- **Multi-SWE-bench** — whole TypeScript set, no filtering.
- **DeepSWE** — unchanged; now one benchmark among several.
- **Uniform results** — attempts, trajectories, dashboard, analysis, and Pages are structurally identical across benchmarks; benchmark and tier are provenance, never new schema.
- **Immutability** — benchmark, tiers, and task list are pinned per study; any change is a new study.
- **Conditions and grading** — stock vs symnav and the binary reward (with f2p/p2p/partial diagnostics) mean the same on every benchmark.
