# Multi-benchmark integration — phased plan

Implements [`functional-spec.md`](functional-spec.md): benchmark becomes a pinned study variable; SWE-PolyBench (TypeScript, fit-tier filtered) and Multi-SWE-bench (whole TypeScript set) run through the existing stock-vs-symnav pipeline; DeepSWE is unchanged and becomes `benchmark = deepswe`.

## Goal

After all phases: a study author declares a `swe-polybench` or `multi-swe-bench` study in symnav-bench-runs, dispatches it through the existing `study dispatcher` workflow, and it runs end-to-end — tasks resolve deterministically, per-instance containers run stock and symnav conditions, grading normalizes to the existing `reward`/`f2p`/`p2p`/`partial` keys, and the dashboard + Pages publish with a benchmark label (and, for SWE-PolyBench, a tier column) as provenance. Every artifact keeps today's shape. DeepSWE studies — declared or new — behave exactly as today.

## Ground rules (read before any phase)

- **Repos.** Three local repos:
  - `/Users/moyaseen/projects/symnav` — product repo. Holds this plan only; no code changes.
  - `/Users/moyaseen/projects/symnav-bench` — Python Docker harness (study schema, task sources, Pier execution, normalization, report/dashboard).
  - `/Users/moyaseen/projects/symnav-bench-runs` — study declarations, GitHub Actions dispatch, `results` branch, Pages. Uses a `blob:none` partial clone.
- **Branches — fixed, one per repo.** All phases touching a repo append commits to that repo's single branch and single draft PR. No stacked PRs.
  - symnav-bench: branch `multi-bench-integration`, based off `origin/main` (current feature branch `trajectory-viewer` is fully merged into `origin/main`).
  - symnav-bench-runs: branch `multi-bench-integration`, based off `origin/main` (current `auto-trajectories` is fully merged).
- **Verification commands** (run before every push):
  - symnav-bench: `python -m pip install -e '.[dev]' && pytest && bash -n entrypoint.sh` (no lint config exists).
  - symnav-bench-runs: `python -m unittest discover -s tests -v`; workflow YAML additionally checked by actionlint in CI (`verify.yml`).
- **Hard constraints** (not negotiable):
  1. No API keys anywhere: agent execution keeps today's Claude Code / Codex ChatGPT-account auth; datasets and eval images must be fetchable/pullable anonymously.
  2. DeepSWE behavior unchanged: committed v1 studies parse byte-compatibly, fingerprints untouched, suite serialization byte-identical.
  3. Never edit a declared study's manifest/execution/suite in `studies/` (study-immutability guardrail).
- **Commit style.** Short imperative titles, no `Co-Authored-By` trailer. TDD: each phase lands failing tests before production code.

## Context

Execution architecture (symnav-bench): a **Pier task directory** is the unit of execution — `task.toml` + `instruction.md` + `environment/` (docker image or Dockerfile) + `tests/test.sh` + optional `pre_artifacts.sh`/`solution/`. `symnav-bench run` (`cli.py:117`) resolves a tasks dir — today via `ensure_deepswe_tasks` (`deepswe.py:61`), which clones the public deep-swe repo at a pinned SHA — then `CellRunner.run_cell` (`run/runner.py:106`) writes a Pier job yaml (`run/job_config.py:34`), shells to `pier run`, and normalizes the trial (`cells/normalize.py:45`) into an attempt record. The verifier contract is data, not code: `tests/test.sh` writes `/logs/verifier/reward.json`; `normalize.py` copies whatever numeric keys appear into `verifier_result.rewards`. Nothing below the tasks-dir seam inspects task content.

DeepSWE task anatomy (public `datacurve-ai/deep-swe` repo, the frame this plan reuses): every task shares one verifier frame — `tests/test.sh` + shared `tests/grader.py` + `tests/config.json` (`base_commit`, `f2p_node_ids`, `p2p_node_ids`, `grade{format, reports}`); the agent works in a container with the repo at base commit; `pre_artifacts.sh` captures `git diff` to `/logs/artifacts/model.patch`; the verifier runs in a **separate** environment, resets+applies `model.patch` then `test.patch`, runs suites, and writes `reward.json` with documented semantics:

```text
reward  = 1 iff f2p_total > 0 AND every f2p passes AND no p2p fails, else 0
f2p     = f2p_passed / f2p_total          (0.0 if the bucket is empty)
p2p     = p2p_passed / p2p_total          (1.0 vacuously if empty)
partial = (f2p_passed + p2p_passed) / (f2p_total + p2p_total)
absence-from-report == failure; skipped == failure; duplicate ids merge worst-status-wins;
model.patch apply failure -> reward.json with zero passes (still a scored attempt)
```

Study contract (symnav-bench `study.py`, symnav-bench-runs `studies/<id>/`): a declared study = `manifest.yml` (JSON-in-YAML: `schema_version`, `id`, `protocol_fingerprint`, `protocol{deep_swe_sha, symnav{...}, repetitions, wall_clock_seconds, randomization_seed, conditions, scoring_policy, practical_uplift_points}`, `configurations[]`) + `suite.json` (`{deep_swe_sha, fingerprint, tasks:[{slug, language, checksum}]}`, resolved at declaration) + `execution.json` (harness image reference/digest pin). `protocol_fingerprint` is sha256 over the raw declared protocol mapping and is validated at load (`study.py:91-99`) and re-derived from `protocol_mapping` when validating attempts (`report/study_dataset.py:325`). Batching (`batch_plan.py`) shuffles complete stock+symnav condition blocks into ≤256-cell batches. Workflows (`symnav-bench-runs/.github/workflows/`): `study.yml` selects batches via the pinned image's `batch-matrix` command and dispatches `bench-batch.yml`, whose setup job extracts manifest metadata via inline python (`bench-batch.yml:54-66`), whose cell jobs run one slot each, and whose report job merges attempts onto the `results` branch, regenerates the dashboard, and triggers Pages. `report/versions.py` gates cross-study comparability on the **suite** fingerprint.

External benchmark facts (verified 2026-07):

| | SWE-PolyBench | Multi-SWE-bench |
|---|---|---|
| Dataset | HF `AmazonScience/SWE-PolyBench`, public, MIT, no token | HF `ByteDance-Seed/Multi-SWE-bench`, public, no token |
| TypeScript tasks | 729 | 224 (`mui/material-ui` 174, `vuejs/core` 48, `darkreader/darkreader` 2), JSONL under `ts/` |
| Key fields | `instance_id`, `repo`, `base_commit`, `problem_statement`, `patch`, `test_patch`, `F2P`, `P2P`, `test_command`, `Dockerfile`, change-shape columns (`is_no_nodes`, `is_single_func`, `is_single_class`, `num_func_changes`, `num_class_changes`, `modified_nodes`) | `org`, `repo`, `number`, `instance_id`, `title`, `body`, `base` (commit), `fix_patch`, `test_patch`, `f2p_tests`, `p2p_tests` |
| Eval images | `ghcr.io/timesler/swe-polybench.eval.x86_64.<instance_id>:v1.1`, anonymous pull | Docker Hub `mswebench/{org}_m_{repo}:pr-{number}`, anonymous pull |
| Test command | per-instance `test_command` column | in the official harness's per-repo TS classes (3 repos), not the dataset |
| Resolved rule | `f2p ⊆ passed ∧ p2p ∩ failed = ∅` | same shape (FAILED→PASSED on f2p, no p2p regression) |

Both official resolved rules are subsumed by the DeepSWE grader semantics above, which this plan adopts verbatim for all benchmarks.

## Design decisions (agreed in the A/B design dialogue)

1. **Task materializer seam.** Each benchmark converts pinned instances into Pier task dirs conforming to `TaskPaths`; all per-benchmark branching lives at materialization + declaration-time resolution. Reward semantics, reward keys, trajectories, and statistics are untouched below the seam (Phase 8 adds provenance-only fields to the attempt record). DeepSWE already *is* the materialized form (clone at SHA).
2. **Byte-deterministic materialization.** Same pinned instance → identical task-dir bytes (no timestamps, stable ordering), so `directory_checksum` keeps its meaning; declaration-time suite building materializes through the same code the runner uses.
3. **Manifest `schema_version: 2`** with a required `protocol.benchmark` block; v1 manifests parse as legacy deepswe byte-untouched; `protocol_mapping` is version-faithful (v1 emits exactly today's dict); new studies — including new deepswe studies — must declare the block ("no implicit benchmark", spec 8.1). v2 rejects a top-level `deep_swe_sha`.
4. **Suite v2** carries `benchmark`, `source_revision`, and per-task `tier`; deepswe suite serialization stays byte-identical so `versions.py` comparability is untouched.
5. **Grading**: generated verifiers write the DeepSWE reward keys with the DeepSWE formulas. Parsers and test-command profiles are **ported into symnav-bench** (3 Multi-SWE TS repo profiles; SWE-PolyBench per-instance `test_command` + TS log parsers) rather than depending on the official eval-harness packages, whose orchestrators duplicate Pier's job.
6. **Runtime acquisition mirrors deepswe**: cells fetch the pinned dataset slice anonymously at materialization time; nothing is redistributed via symnav-bench-runs; the materialized dir is verified against the suite checksum.
7. **Workflow schema knowledge moves into the harness**: new `study-metadata` CLI replaces `bench-batch.yml`'s inline python, so workflows work for v1 and v2 studies alike.
8. **Smoke studies** for both new benchmarks land in the symnav-bench-runs PR pinned to a feature-branch-published harness image (existing `publish.yml` `workflow_dispatch` mechanism, same way `sha-75cc289` was pinned), following the existing 1-task deepswe smoke precedent. Production studies are declared post-merge by the author.

## Open questions (resolve in the noted phase)

- **OQ1 (Phase 5).** Eval-image tags (`:v1.1`, `:pr-N`) are not digest-pinned. Accept tag-pin (record tag in the checksummed task dir) vs resolving per-instance digests at declaration (~729 registry probes). Decide after probing a handful of images.
- **OQ2 (Phase 4).** Verify `F2F` column presence in the full SWE-PolyBench set at ingest (grading ignores it either way).
- **OQ3 (Phases 5, 6).** In-image repo workdir per image family (`/app` vs other) — verify with a probe container before finalizing the generated `test.sh`.
- **OQ4 (Phase 10).** Docker Hub anonymous pull limits for `mswebench` images on GitHub runners — probe during smoke; fallback is a free Docker Hub account secret (still no paid key).
- **OQ5 (Phase 8).** Whether `report/official_reference.py` needs benchmark-awareness or is deepswe-only display data.

---

## Phase 1 — Benchmark-aware study manifest (schema v2)

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** `StudyManifest.load` parses v2 manifests declaring `protocol.benchmark` for all three benchmarks, rejects invalid declarations (unknown name, bad/empty tier sets, v2 with top-level `deep_swe_sha`, tiers on non-polybench), and keeps parsing every committed v1 manifest byte-compatibly — same fingerprints, same normalized view. All existing consumers keep working through a normalized benchmark object.

**Test cases** (unit, `tests/test_study.py`):
- v1 manifest (copy a real committed one from symnav-bench-runs as a fixture) loads; `protocol_fingerprint()` reproduces the committed fingerprint; normalized `protocol.benchmark` is `deepswe` with `source_revision == deep_swe_sha`.
- v2 deepswe manifest (`benchmark: {name: deepswe, source: {revision: <sha>}}`) loads; `protocol_mapping` round-trips the v2 shape exactly (fingerprint stable across load→map→fingerprint).
- v2 swe-polybench manifest with `tiers: [high, mid]` loads; tiers normalized in declaration order, duplicates rejected.
- v2 multi-swe-bench manifest (no tiers) loads.
- Rejections: unknown benchmark name; empty tier list; tier value outside high/mid/low; tiers present on deepswe or multi-swe-bench; v2 manifest carrying top-level `deep_swe_sha`; v1 manifest carrying a `benchmark` block; non-SHA source revision.

**Components.**

```python
# study.py
BenchmarkName = Literal["deepswe", "swe-polybench", "multi-swe-bench"]
FitTier = Literal["high", "mid", "low"]
BENCHMARK_NAMES: tuple[BenchmarkName, ...]
FIT_TIERS: tuple[FitTier, ...]

@dataclass(frozen=True)
class BenchmarkSelection:
    name: BenchmarkName
    source_revision: str            # git sha of deep-swe repo, or HF dataset repo revision
    tiers: tuple[FitTier, ...] | None   # swe-polybench only; None otherwise

@dataclass(frozen=True)
class StudyProtocol:
    benchmark: BenchmarkSelection   # replaces deep_swe_sha as the normalized source pin
    # symnav, repetitions, wall_clock_seconds, randomization_seed,
    # conditions, scoring_policy, practical_uplift_points unchanged

@dataclass(frozen=True)
class StudyManifest:
    schema_version: int             # 1 (legacy deepswe) or 2
    ...

def parse_protocol(data: dict[str, Any], schema_version: int) -> StudyProtocol
def protocol_mapping(protocol: StudyProtocol, schema_version: int) -> dict[str, Any]
```

v1 parsing is today's code path plus normalization into `BenchmarkSelection("deepswe", deep_swe_sha, None)`; v1 `protocol_mapping` emits exactly today's dict (`deep_swe_sha` key, no `benchmark` key). v2 parsing requires the block and forbids `deep_swe_sha`. `StudyProtocol.deep_swe_sha` accessors used by other modules (`batch_plan.py:33`, `cli.py`, `run/runner.py`, `report/study_dataset.py`) are mechanically updated to read `protocol.benchmark.source_revision`; deepswe-conditional callers keep identical behavior.

**Commit plan.**
1. `test: cover v1 study manifest back-compat with committed fixture` — failing/green regression tests pinning current parse+fingerprint behavior before any change (tests only).
2. `add BenchmarkSelection types` — type definitions only, no callsites (type-then-use rule).
3. `test: cover v2 benchmark block parse and rejections` — failing tests for the v2 contract (tests only).
4. `parse benchmark block, normalize v1 to deepswe` — `parse_protocol`/`protocol_mapping` version-faithful implementation; consumers switched to the normalized object in the same commit only where the field rename forces it (one logical change: source-pin normalization).

**Done when.** All listed tests green; full `pytest` green; a committed v1 manifest fixture's fingerprint is asserted unchanged.

---

## Phase 2 — Generalized suite manifest

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** `suite.json` can describe any benchmark's pinned task set — with per-task fit tier for SWE-PolyBench — while deepswe suites serialize/parse byte-identically to today (suite fingerprints and `versions.py` comparability untouched).

**Test cases** (unit, `tests/test_suite.py`):
- Existing deepswe suite fixture round-trips byte-identically (serialize(parse(x)) == x); fingerprint unchanged.
- v2 suite for swe-polybench: `{benchmark, source_revision, fingerprint, tasks:[{slug, language, checksum, tier}]}` parses; fingerprint covers benchmark + revision + tasks incl. tier; slug is the instance id verbatim (`microsoft__vscode-106767`).
- v2 suite for multi-swe-bench: same shape, no `tier` key on tasks.
- Mismatch rejection: suite benchmark/revision differing from the manifest's `BenchmarkSelection` fails `plan_trial_slots` (extends the existing `deep_swe_sha` match check in `batch_plan.py:33`).
- Tier value validation: only high/mid/low accepted; tier on a non-polybench suite rejected.

**Components.**

```python
# suite.py
@dataclass(frozen=True)
class TaskManifestEntry:
    slug: str
    language: str
    checksum: str
    tier: FitTier | None = None     # serialized only when present

@dataclass(frozen=True)
class SuiteManifest:
    benchmark: BenchmarkName
    source_revision: str            # == deep_swe_sha for deepswe
    tasks: tuple[TaskManifestEntry, ...]
    fingerprint: str

def parse_suite_manifest(raw: dict[str, Any]) -> SuiteManifest   # accepts legacy + v2 shapes
def suite_mapping(suite: SuiteManifest) -> dict[str, Any]        # legacy shape for deepswe, v2 otherwise
def suite_fingerprint(suite: ...) -> str                          # legacy algorithm for deepswe, extended for v2
```

The scattered ad-hoc suite parsing in `cli.py:185-190`, `run/runner.py:51-55`, and `report/study_dataset.py:271` collapses onto `parse_suite_manifest`.

**Commit plan.**
1. `test: pin legacy suite round-trip byte-identity` — regression tests first (tests only).
2. `add tier and benchmark fields to suite manifest types` — type/dataclass change + serialization, no new callsites beyond mechanical field threading (one logical change).
3. `test: cover v2 suite parse, fingerprint, and mismatch rejection` (tests only).
4. `centralize suite parsing behind parse_suite_manifest` — refactor only, no behavior change (refactor-before-feature rule).
5. `implement v2 suite serialization and study/suite match check` — feature on top of the refactor.

**Done when.** Tests green; committed deepswe `suite.json` fixtures parse with unchanged fingerprints; `plan_trial_slots` rejects cross-benchmark suite/manifest pairs.

---

## Phase 3 — Benchmark task-source seam (deepswe refactor, no behavior change)

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** One dispatch point maps a `BenchmarkSelection` to a task source that can (a) resolve the pinned selection into a `SuiteManifest` at declaration time and (b) produce a Pier tasks dir for requested slugs at run time. DeepSWE moves behind it with byte-identical behavior; `cli.py`/`run/runner.py` stop referencing deepswe directly.

**Test cases** (unit, new `tests/test_benchmark_sources.py` + existing suites):
- `benchmark_task_source(BenchmarkSelection("deepswe", sha, None))` returns a source whose `ensure_tasks_dir` invokes the existing clone path (fake `GitRunner`) and whose `resolve` reproduces `build_suite_manifest` output for a fixture tasks dir.
- Dispatch rejects selections whose name has no registered source (exhaustiveness guard for future edits).
- All existing `test_run.py` / `test_tasks_cli.py` tests stay green unmodified (behavior-preservation evidence).

**Components.**

```python
# benchmark_sources/__init__.py  (new package directory)
class BenchmarkTaskSource(ABC):
    selection: BenchmarkSelection
    @abstractmethod
    def resolve(self) -> SuiteManifest: ...
        # declaration-time: enumerate + pin the task set (downloads allowed)
    @abstractmethod
    def ensure_tasks_dir(self, slugs: Sequence[str], workdir: Path) -> Path: ...
        # run-time: produce a directory containing one Pier task dir per slug

def benchmark_task_source(selection: BenchmarkSelection) -> BenchmarkTaskSource

# benchmark_sources/deepswe_source.py — wraps deepswe.ensure_deepswe_tasks + suite.build_suite_manifest
```

Keep the seam exactly this small — no plugin registry, no capability flags (three benchmarks, one factory function).

**Commit plan.**
1. `test: cover deepswe task source behavior-preservation` (tests only, against the not-yet-extracted seam — red).
2. `add BenchmarkTaskSource interface` — abstract class only, no implementations (type-then-use).
3. `move deepswe task acquisition behind DeepsweTaskSource` — pure move/wrap, no logic edits (move-without-change rule).
4. `dispatch cli run path through benchmark_task_source` — refactor of `cli.py:121` fallback chain, behavior unchanged.

**Done when.** Full `pytest` green with zero edits to pre-existing run-path tests; `git log` shows the move and the dispatch as separate commits.

---

## Phase 4 — SWE-PolyBench resolution and fit tiers (`resolve-suite` CLI)

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** `symnav-bench resolve-suite --study manifest.yml --out suite.json` resolves a swe-polybench study: downloads the pinned HF dataset revision anonymously, filters TypeScript rows, assigns each task exactly one fit tier by the pinned rule, applies the manifest's tier selection, and writes a v2 `suite.json` plus a planned task/slot count summary to stdout (spec §7 cost visibility). Deterministic: same revision + tiers → identical file. Also resolves deepswe studies (delegating to the Phase 3 source) so declaration tooling is uniform.

**Test cases** (unit, `tests/test_polybench_source.py`, fixture = a small JSONL/dict sample of dataset rows covering every tier branch):
- Tier rule table test, one row per branch:
  - `is_single_func` → low; `is_single_class` → low; `is_no_nodes` → low (even with high node counts).
  - not-single ∧ `modified_nodes >= 6` → high; not-single ∧ `num_func_changes + num_class_changes >= 4` → high.
  - not-single ∧ below both thresholds → mid.
- Language filter: non-TypeScript rows excluded.
- Selection: `tiers=[high,mid]` keeps only those tasks; `[high,mid,low]` keeps all; resolved set sorted by instance id; empty resolved set → error (spec §7 empty-selection rejection).
- `resolve-suite` CLI writes a v2 suite whose fingerprint is stable across two runs (determinism, integration-level with fetch stubbed).
- Row-integrity: missing change-shape column → hard error naming the instance (no silent tier default). `F2F` column present or absent is tolerated (OQ2).

**Components.**

```python
# benchmark_sources/swe_polybench_source.py
@dataclass(frozen=True)
class PolybenchInstance:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    test_patch: str
    f2p: tuple[str, ...]
    p2p: tuple[str, ...]
    test_command: str
    dockerfile: str
    change_shape: PolybenchChangeShape

@dataclass(frozen=True)
class PolybenchChangeShape:
    is_no_nodes: bool
    is_single_func: bool
    is_single_class: bool
    num_func_changes: int
    num_class_changes: int
    modified_nodes: int

def fit_tier(shape: PolybenchChangeShape) -> FitTier

class SwePolybenchTaskSource(BenchmarkTaskSource):
    def resolve(self) -> SuiteManifest: ...
    def ensure_tasks_dir(self, slugs, workdir) -> Path: ...   # NotImplemented until Phase 5

# dataset_fetch.py (shared by both HF sources)
def fetch_dataset_files(repo_id: str, revision: str, paths: Sequence[str], dest: Path) -> list[Path]
    # anonymous GET https://huggingface.co/datasets/<repo_id>/resolve/<revision>/<path>
```

Fetching: discover the dataset's file layout at the pinned revision via the public tree API, download data files with plain HTTPS (no `huggingface_hub` dependency; `pyarrow` is already a dependency if shards are parquet). The tier rule is the spec 8.2 rule verbatim; instance ids are used as task slugs unchanged.

`cli.py` gains the subcommand:

```python
resolve_suite_parser = subcommands.add_parser("resolve-suite")
resolve_suite_parser.add_argument("--study", type=Path, required=True)
resolve_suite_parser.add_argument("--out", type=Path, required=True)
```

**Commit plan.**
1. `test: cover fit tier rule and TS filtering` (tests only).
2. `add PolybenchInstance types and fit_tier` — types + pure tier function, no I/O.
3. `test: cover polybench resolve and resolve-suite determinism` (tests only, fetch stubbed).
4. `add anonymous HF dataset fetch helper` — I/O helper with no benchmark knowledge.
5. `implement SwePolybenchTaskSource.resolve and resolve-suite command` — wires source + CLI.

**Done when.** Tests green; running `resolve-suite` twice against a stubbed dataset produces byte-identical suites; empty tier selection errors at declaration, not dispatch.

---

## Phase 5 — Task materializer frame + SWE-PolyBench materializer

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** A swe-polybench slug materializes into a complete, byte-deterministic Pier task dir: agent environment on the instance's prebuilt eval image, `instruction.md` from the problem statement, `pre_artifacts.sh` capturing `model.patch`, and a generated verifier (`tests/test.sh` + `tests/grade.py` + `tests/config.json`) that applies `model.patch` + `test_patch`, runs the instance's `test_command`, parses the log, and writes `reward.json` with the DeepSWE formulas. `SwePolybenchTaskSource.ensure_tasks_dir` works end-to-end; suite checksums computed at declaration match run-time materialization.

**Test cases** (unit + integration, `tests/test_materializer.py`, `tests/test_polybench_grading.py`):
- Determinism: materializing the same fixture instance twice → identical `directory_checksum` (the load-bearing guarantee from decision 2).
- Frame contents: generated dir passes `TaskPaths.is_valid()`; `task.toml` pins `environment.docker_image` to the instance image ref, `verifier.environment_mode = "separate"`, `metadata.language = "typescript"`; `instruction.md == problem_statement`; no timestamps anywhere.
- Grading math (drive `tests/grade.py` directly on captured sample logs checked in as fixtures — jest/mocha/vitest outputs from real polybench TS instances):
  - all f2p pass + all p2p pass → `{reward: 1, f2p: 1.0, p2p: 1.0, partial: 1.0}`.
  - one f2p fails → reward 0, fractional f2p/partial.
  - p2p regression with full f2p → reward 0.
  - test absent from log → counted failed; empty f2p bucket → f2p 0.0, reward 0; empty p2p bucket → p2p 1.0.
  - model.patch apply failure → reward.json zeros with `apply_failed` marker (attempt still scored, matching DeepSWE).
- `ensure_tasks_dir` fetches only the requested slugs' records (stubbed fetch) and verifies materialized checksums against a provided suite entry, erroring on mismatch.

**Components.**

```python
# benchmark_sources/pier_task_writer.py — shared frame writer (used by Phases 5 and 6)
@dataclass(frozen=True)
class MaterializedTaskSpec:
    slug: str
    instruction: str
    docker_image: str
    workdir: str                       # in-image repo path (OQ3)
    test_patch: str
    f2p: tuple[str, ...]
    p2p: tuple[str, ...]
    test_command: str
    log_parser: str                    # parser id baked into tests/config.json
    wall_clock_seconds: int | None

def write_pier_task_dir(spec: MaterializedTaskSpec, dest: Path) -> Path

# benchmark_sources/grading/  — parser ports + reward math, copied INTO the task dir at
# materialization (tests/grade.py must be self-contained inside the verifier container)
def parse_test_log(parser: str, log_text: str) -> TestOutcomes   # passed/failed/skipped name sets
def rewards(outcomes: TestOutcomes, f2p: ..., p2p: ..., apply_failed: bool) -> dict[str, float]
```

Prose notes for the implementer: `tests/grade.py` is generated as a standalone python file (the eval images ship python3 like DeepSWE's; verify per family — OQ3 probe); the reward math and parser port live in symnav-bench source and are embedded verbatim so unit tests exercise the same code that runs in-container. SWE-PolyBench TS log parsing ports the official `parsers/` for the frameworks its TS repos use. Resolve OQ1 (tag vs digest pin) here with a registry probe; record the outcome in the commit message and, if digest-pinning is chosen, store the digest in `tests/config.json` (checksummed).

**Commit plan.**
1. `test: cover pier task frame determinism and validity` (tests only).
2. `add MaterializedTaskSpec and frame writer` — frame writer, no benchmark specifics.
3. `test: cover polybench grading math on captured logs` (tests only, fixtures added).
4. `add test-log parsers and reward math` — grading library, no materializer wiring.
5. `implement polybench materializer and ensure_tasks_dir` — connects instance → spec → task dir with checksum verification.

**Done when.** Tests green; a fixture instance materializes into a `TaskPaths`-valid dir twice with equal checksums; grading fixtures reproduce the DeepSWE key semantics exactly.

---

## Phase 6 — Multi-SWE-bench source and materializer

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** `multi-swe-bench` studies resolve (whole `ts/` set, no tiers) and materialize end-to-end: instance records from the pinned HF revision's `ts/*.jsonl`, per-repo execution profiles (image name pattern, prepare/test commands, log parser regexes) ported from the official harness's three TypeScript repo classes, graded with the same reward math as Phase 5.

**Test cases** (unit, `tests/test_multi_swe_source.py`):
- Resolution: fixture jsonl rows for all three repos resolve to a v2 suite, sorted by instance id, no tier keys; counts match fixture; `resolve-suite` works for a multi-swe manifest.
- Repo profiles: for each of `mui/material-ui`, `vuejs/core`, `darkreader/darkreader` — image name `mswebench/{org}_m_{repo}:pr-{number}` derived correctly; test command and parser id match the ported profile; an instance from an unknown repo → hard error (future dataset growth must be conscious).
- Parser ports: captured sample logs (vitest `✓/×` for vuejs/core, plus the other two repos' formats) parse into expected passed/failed sets.
- Materializer: determinism + `TaskPaths.is_valid()` (reuses Phase 5 frame tests parametrized over benchmarks).
- Grading: `f2p_tests`/`p2p_tests` lists flow into `tests/config.json`; reward math cases reuse Phase 5's suite parametrized with multi-swe fixtures.

**Components.**

```python
# benchmark_sources/multi_swe_bench_source.py
@dataclass(frozen=True)
class MultiSweInstance:
    instance_id: str
    org: str
    repo: str
    number: int
    base_commit: str
    problem_statement: str            # title + body
    test_patch: str
    f2p: tuple[str, ...]
    p2p: tuple[str, ...]

@dataclass(frozen=True)
class RepoExecutionProfile:
    org: str
    repo: str
    workdir: str
    prepare_command: str | None
    test_command: str
    log_parser: str

REPO_PROFILES: tuple[RepoExecutionProfile, ...]   # exactly three entries

class MultiSweBenchTaskSource(BenchmarkTaskSource):
    def resolve(self) -> SuiteManifest: ...
    def ensure_tasks_dir(self, slugs, workdir) -> Path: ...
```

**Commit plan.**
1. `test: cover multi-swe resolution and repo profiles` (tests only).
2. `add MultiSweInstance types and repo profiles` — data only.
3. `test: cover multi-swe log parsing on captured logs` (tests only, fixtures).
4. `implement MultiSweBenchTaskSource` — resolve + materialize on the Phase 5 frame.

**Done when.** Tests green; both new benchmarks resolve and materialize through the same `resolve-suite` CLI and frame writer; unknown-repo instances fail loudly.

---

## Phase 7 — Runner dispatch and `study-metadata` CLI

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** A cell job for a v2 study runs end-to-end inside the harness: `StudyRunContext` carries the benchmark selection; `run` materializes non-deepswe tasks into a temp tasks dir via the Phase 3 dispatch before invoking Pier; deepswe cells take the byte-identical current path. New `study-metadata` command emits the JSON the workflow setup step needs (agent spec/version, benchmark name, source revision, fingerprints) for v1 and v2 studies alike.

**Test cases** (unit, `tests/test_run.py`, `tests/test_tasks_cli.py`):
- `StudyRunContext.from_environment` on a v2 polybench manifest exposes the selection; `CellRunner.run_cell` with a fake Pier and stubbed materializer receives a job yaml whose task path points at the materialized dir; the normalized attempt's harness identity carries the benchmark source revision.
- Deepswe v1 context: existing tests unchanged and green (behavior preservation).
- `run` CLI for a benchmark study without `SYMNAV_BENCH_STUDY_MANIFEST` (ad-hoc mode) rejects non-deepswe benchmarks with a clear error (study manifests are the only entry to new benchmarks — no new ad-hoc flag surface).
- `study-metadata --study --suite --configuration` output: exact JSON for a v1 fixture (matches what `bench-batch.yml`'s inline python emits today, plus `benchmark`) and for a v2 fixture.
- `list-tasks`/`plan-study` against a v2 study print the resolved instance ids and slot counts.

**Components.**

```python
# run/runner.py
@dataclass(frozen=True)
class StudyRunContext:
    benchmark: BenchmarkSelection      # new; from the manifest
    ...                                # existing fields unchanged

# cli.py
study_metadata_parser = subcommands.add_parser("study-metadata")
study_metadata_parser.add_argument("--study", type=Path, required=True)
study_metadata_parser.add_argument("--suite", type=Path, required=True)
study_metadata_parser.add_argument("--configuration", required=True)
# stdout JSON: {agent_spec, agent_version, benchmark, source_revision,
#               protocol_fingerprint, suite_fingerprint}
```

`--deep-swe-ref` stays for v1/ad-hoc use; v2 studies get everything from the mounted manifests, so cell invocations need no new flags (the workflow keeps passing the same arguments; the harness ignores `--deep-swe-ref` for non-deepswe studies).

**Commit plan.**
1. `test: cover v2 study run context and cell dispatch` (tests only).
2. `thread BenchmarkSelection through StudyRunContext and cell runner` — run-path integration.
3. `test: cover study-metadata output for v1 and v2 studies` (tests only).
4. `add study-metadata command` — CLI addition matching today's inline-python contract.

**Done when.** Full `pytest` green; a v2 study's cell path is exercised with fakes end-to-end (materialize → job yaml → normalize); `study-metadata` reproduces today's metadata for v1 fixtures.

---

## Phase 8 — Provenance in attempts, dashboard, and exports

**Repo:** `/Users/moyaseen/projects/symnav-bench` (branch `multi-bench-integration`)

**Behavior delivered.** Every attempt records `benchmark`, `benchmark_source_revision`, and `task_fit_tier` (tier only for swe-polybench, `null` otherwise); deepswe attempts stay byte-compatible (existing `deep_swe_sha` fields untouched). The dashboard shows a benchmark label in the study header and a tier column in the matrix + per-task drill-down for polybench studies only; `analysis.json` and CSV/Parquet exports carry the new provenance columns. Metric fields, coverage handling, and layout are otherwise unchanged.

**Test cases** (unit, `tests/test_attempt.py`, `tests/test_dashboard_payload.py`, `tests/test_exports.py`, `tests/test_study_dataset.py`):
- Attempt schema: normalizing a v2 polybench trial writes `benchmark: "swe-polybench"`, source revision, `task_fit_tier: "high"`; a deepswe attempt fixture serializes byte-identically to the pre-phase golden copy.
- Study dataset: loading a v2 study joins tier from `suite.json` onto task metrics; attempt-vs-manifest validation accepts v2 fingerprints (extends `study_dataset.py:325-336`).
- Dashboard payload: v2 polybench study → `benchmark` in the header block, `tier` on each matrix row; multi-swe study → benchmark label, no tier key; deepswe payload unchanged vs golden fixture.
- Exports: attempts CSV/Parquet gain `benchmark`/`tier` columns; deepswe rows populate `deepswe`/empty.
- OQ5 resolved: assert `official_reference` handling for non-deepswe studies (rendered as absent, or benchmark-aware — decide from what the module actually displays).

**Components.**

```python
# cells/attempt.py — AttemptRecord provenance additions
@dataclass(frozen=True)
class HarnessIdentity:
    benchmark: BenchmarkName
    benchmark_source_revision: str
    deep_swe_sha: str                  # kept, == source revision for deepswe (back-compat readers)
    ...

# report/study_dataset.py TaskMetrics/AttemptView gain: tier: FitTier | None
```

Dashboard: tier renders as a compact column in the matrix and drill-down only when any task has a tier (payload-driven, no benchmark conditional in JS); keep the established dashboard rules (dense, no green palette, two-decimal scores).

**Commit plan.**
1. `test: pin deepswe attempt and payload golden fixtures` (tests only — byte-compat evidence before change).
2. `record benchmark provenance in attempt identity` — normalize-path change.
3. `test: cover tier and benchmark in dataset, payload, exports` (tests only).
4. `surface benchmark label and tier column in dashboard and exports` — report-layer change.

**Done when.** Tests green; deepswe golden fixtures byte-identical; a rendered v2 dashboard fixture shows the label + tier column; this completes the symnav-bench PR scope — run the full verification command and update the draft PR description.

---

## Phase 9 — Workflow generalization in symnav-bench-runs

**Repo:** `/Users/moyaseen/projects/symnav-bench-runs` (branch `multi-bench-integration`)

**Behavior delivered.** `study.yml` and `bench-batch.yml` dispatch and run v2 studies of any benchmark unchanged from the author's perspective (same three inputs), and keep running committed v1 deepswe studies. Schema knowledge moves out of workflow YAML: the setup job calls `study-metadata` from the pinned image instead of inline python; cell jobs pass no benchmark-specific flags. README documents the full declaration procedure for the three benchmarks.

**Test cases** (workflow contract tests, `tests/test_workflow_contract.py` — these read the YAML from disk, existing pattern):
- `bench-batch.yml` setup contains no inline `manifest["protocol"]["deep_swe_sha"]` python; it invokes `study-metadata` and maps its JSON keys onto the same step outputs (`agent_spec`, `deep_swe_sha`→`source_revision`, fingerprints).
- Cell step passes `--deep-swe-ref` only from the metadata's source revision (v1-compatible) and mounts study + symnav checkout exactly as today; no new secrets introduced (constraint: no API keys).
- `study.yml` batch selection remains benchmark-agnostic (pure `batch-matrix` passthrough).
- `recover-report.yml` and `pages.yml` untouched or benchmark-agnostic (assert no `deepswe` literals).
- README section: declaration procedure includes `publish.yml` dispatch → `execution.json` digest pin → `resolve-suite` inside the pinned image → commit `manifest.yml` + `suite.json` + `execution.json`; study ids follow the spec §5 naming convention — the id names the benchmark and, for swe-polybench, the tier set (`swe-polybench-ts-himid-codex-terra-medium-pr94`, `swe-polybench-ts-all-...`, `multi-swe-bench-ts-...`); smoke ids in Phase 10 follow the same benchmark-first convention.

**Components.** Workflow-step contract (shape, not implementation):

```yaml
# bench-batch.yml setup step
metadata=$(docker run --rm -v "$PWD:/workspace:ro" "$image" study-metadata \
  --study "/workspace/$root/manifest.yml" \
  --suite "/workspace/$root/suite.json" \
  --configuration '${{ inputs.configuration }}')
```

**Commit plan.**
1. `test: cover benchmark-agnostic workflow contract` (contract tests first, red against current YAML).
2. `use study-metadata in bench-batch setup` — one logical change: metadata extraction swap.
3. `document multi-benchmark study declaration` — README only.

**Done when.** `python -m unittest discover -s tests -v` green; actionlint green; dispatching a committed v1 deepswe smoke study from this branch still works (verified in Phase 10 alongside the new smokes).

---

## Phase 10 — Smoke studies: end-to-end proof on both new benchmarks

**Repo:** `/Users/moyaseen/projects/symnav-bench-runs` (branch `multi-bench-integration`)

**Behavior delivered.** Two declared smoke studies — `swe-polybench-ts-smoke` (2 tasks, one high + one mid tier) and `multi-swe-bench-ts-smoke` (2 tasks, two repos) — pinned to a harness image published from the symnav-bench feature branch, each dispatched through `study dispatcher` and finishing with normalized attempts on `results`, a dashboard with benchmark label (and tier column for polybench), and Pages publication. This is the constraint-3 "just works" proof, pre-merge.

**Test cases.**
- Declaration tests (unit, extending the `test_terra_medium_study.py` pattern): each smoke study's manifest is schema v2 with the right benchmark block, fingerprint validates, suite is v2 with expected task count/tiers, `execution.json` pins an immutable digest.
- End-to-end (operational, recorded in the PR description): per study — dispatcher run green; cell jobs produce attempts with `benchmark` + tier provenance; report job commits to `results`; dashboard URL renders; one symnav and one stock attempt spot-checked for reward keys present. OQ4 (Docker Hub pulls) probed here; if rate-limited, add the documented free-account fallback before production studies.

**Components.** Study declaration procedure (the README steps from Phase 9, executed):
1. In symnav-bench: dispatch `publish.yml` on `multi-bench-integration` (workflow_dispatch); record `sha-<sha>` tag + digest.
2. In the published image: run `resolve-suite` for each smoke manifest; smoke suites are reduced at declaration time to 2 tasks each (existing deepswe smoke precedent — operational scaffolding, outside spec §8 selection rules; production studies must not subset).
3. Commit `studies/swe-polybench-ts-smoke/` and `studies/multi-swe-bench-ts-smoke/` (manifest + suite + execution) with declaration tests.
4. Dispatch both via `gh workflow run study.yml --ref multi-bench-integration`; iterate on failures by appending fix commits to whichever repo's branch owns the defect (harness fixes go to symnav-bench + republish image + re-pin a NEW smoke study id if a pinned artifact must change — never edit a declared study).

**Commit plan.**
1. `test: declare smoke study contracts` (declaration tests, red).
2. `declare swe-polybench and multi-swe-bench smoke studies` — manifests + suites + execution pins.
3. (as needed) `fix: <defect>` commits from smoke iteration, each one focused; harness defects land in symnav-bench instead.
4. `record smoke results in README` — dashboard URLs + outcomes.

**Done when.** Both smoke dashboards live on Pages with correct provenance; declaration tests green; both draft PR descriptions updated with the smoke evidence and diagrams.

---

## Out of scope

- Any benchmark beyond the three (SWE-bench Multilingual/Multimodal/Pro, SWE-Lancer, Aider Polyglot) — future spec work.
- Non-TypeScript tasks of either benchmark; tier filtering for Multi-SWE-bench; repo-level filtering for SWE-PolyBench — excluded by the functional spec.
- Cross-benchmark dashboards or dispatch-time selection — forbidden by the spec's no-override rules.
- Production study declarations (e.g. `swe-polybench-ts-himid-codex-terra-medium-pr94`) — post-merge author action following the Phase 9 README procedure.
- Changes to DeepSWE task content, scoring, conditions, or repetition policy.
- symnav product-repo code changes — none required; treatment injection is benchmark-independent.
