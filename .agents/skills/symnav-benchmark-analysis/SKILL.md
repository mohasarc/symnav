---
name: symnav-benchmark-analysis
description: Continue, analyze, operate, or recover Symnav benchmark studies across the symnav product, symnav-bench harness, and symnav-bench-runs GitHub Actions/results repositories. Covers all integrated benchmarks (DeepSWE, SWE-PolyBench, Multi-SWE-bench). Use for new experiments, study reports, dashboard work, benchmark recovery, statistical analysis, or GitHub Pages publication.
---

# Symnav benchmark analysis

Treat a study—not a GitHub Actions run—as the analytical unit. Preserve immutable task evidence and do not rerun task cells merely to repair reporting.

## What this program is proving

The headline question is causal: for a fixed coding agent, model, and effort level, does adding full Symnav cause the agent to fully solve more TypeScript tasks than stock, on the study's pinned benchmark? The public-facing score must be comparable in spirit to SWE-Deep: each task receives 0%, 25%, 50%, 75%, or 100% from four independent binary verifier rewards, then task scores are macro-averaged. A one-repetition study yields only 0%/100% per task; treat those as pilots, not production statistics.

Partial verifier metrics, command-pair variants, adoption, cost, duration, and trajectory analysis are internal diagnostics. They help improve Symnav, but they do not replace the primary stock-versus-full-Symnav claim.

## Orient first

This skill is the durable handoff. Do not depend on historical plan or handoff documents; they may be removed. Locate the three repositories from the current workspace or their Git remotes; do not rely on temporary worktree names.

| Repository | Owns |
| --- | --- |
| `symnav` | Product, agent integration skills/rules, pinned Symnav revisions. |
| `symnav-bench` | Docker harness, study schema, normalization, statistics, static dashboard renderer/image. |
| `symnav-bench-runs` | Study manifests, Actions dispatch/recovery, `results` branch, GitHub Pages deployment. |

Before acting, inspect each repository's current branch, dirty state, latest commit, configured remote, relevant study manifest, and `execution.json`. For external state, inspect the exact GitHub Actions run/job and `results` branch. Earlier handoff notes can be stale; the committed manifests, normalized attempts, and current workflow logs are authoritative.

## Product and harness architecture

- Symnav agent-integration assets live in the product repository under `.agents/integrations/symnav/`. Full and command-variant skills/rules are product content and are injected by the harness from the pinned Symnav SHA. Do not hard-code treatment text in the harness.
- `symnav-bench` owns agent execution, benchmark task acquisition, trial normalization, trajectory extraction, paired statistics, CSV/Parquet exports, and the static dashboard bundle. Its Docker image is immutable for a study.
- Benchmark-specific behavior lives behind the task-source seam (`benchmark_sources/`): each benchmark resolves pinned instances at declaration (`resolve-suite` CLI) and materializes byte-deterministic Pier task dirs at run time. Below the seam — reward keys, normalization, statistics, dashboard — nothing branches on benchmark. Benchmark identity and (SWE-PolyBench) fit tier are provenance fields on attempts and dashboard, never schema changes.
- `symnav-bench-runs` owns declared studies under `studies/`, GitHub Actions batch execution, and public result publication. Its `results` branch is the canonical normalized evidence store; Pages copies dashboards from that branch.
- A GitHub batch may be split for the Actions matrix limit. Batches are execution shards, not separate experiments. A model configuration is complete only after all its planned slots are represented in the same study.

## Benchmarks

A study pins exactly one benchmark; comparing benchmarks means comparing studies. Study ids name the benchmark (`swe-polybench-ts-himid-...`, `multi-swe-bench-ts-...`). Manifest `schema_version: 2` requires a `protocol.benchmark` block; v1 manifests parse as legacy deepswe, byte-untouched. Everything is keyless: Hugging Face datasets, GHCR and Docker Hub eval images, and agent auth (Claude Code / Codex ChatGPT-account) — never introduce an API key.

| | `deepswe` | `swe-polybench` | `multi-swe-bench` |
| --- | --- | --- | --- |
| Tasks | 35 TS, no selection knobs | TS tasks filtered by fit tier (`high`/`mid`/`low`, default high+mid) | whole TS set (224 instances: mui/material-ui, vuejs/core, darkreader) |
| Source | `datacurve-ai/deep-swe` clone at SHA | HF `AmazonScience/SWE-PolyBench` | HF `ByteDance-Seed/Multi-SWE-bench` |
| Eval images | built from task dirs | per-instance GHCR, digest-pinned at declaration | Docker Hub `mswebench/{org}_m_{repo}:pr-{n}` |
| Native grading data | `tests/config.json` f2p/p2p node ids | `F2P`/`P2P` columns + per-instance `test_command` | `f2p_tests`/`p2p_tests`; test command is `bash /home/run.sh` baked into images |

Key operational facts:

- Fit tiers are a pinned rule over SWE-PolyBench change-shape metadata (single-function/class → low; multi-locus breadth → high; residual → mid). Real TS counts: 116 high / 130 mid / 483 low — but only published GHCR images are runnable, leaving **75 high+mid tasks** (37 high / 38 mid); unpublished instances are excluded at declaration with slugs listed.
- f2p/p2p is native to the whole SWE-bench family; what the harness adds is uniform normalization: DeepSWE's reward formula (`reward=1 iff f2p_total>0 ∧ all f2p pass ∧ no p2p fails`) subsumes both benchmarks' official resolved rules, and the fractional `f2p`/`p2p`/`partial` diagnostics are harness instrumentation.
- SWE-PolyBench verifiers need internet (test commands fetch packages); the verifier env runs with network enabled while the agent env stays offline. Multi-SWE verifiers run offline.
- `model.patch` is diffed against a pre-agent baseline tree snapshot, not `base_commit` — eval images bake untracked files into the workdir, and injected treatment files must not leak into patches.
- Sanity-check verifier health before trusting scores: mass all-zero results with p2p ≈ 0 across tasks means a broken environment, not failing agents.

## Known historical state

The first production-style reference study was `deepswe-ts-codex-terra-medium-pr94`: 35 TypeScript tasks, stock versus full Symnav, four trials, 280 planned slots. Its recovered complete report showed stock 33.57% and Symnav 35.71%. Treat this as one estimate, not proof by itself. A lower-cost Codex study with the same product revision/protocol was subsequently created as `deepswe-ts-codex-terra-low-pr94`; always inspect its live coverage and normalized evidence rather than assuming completion.

Multi-benchmark integration landed 2026-07-21 via draft PRs symnav#95 (plan), symnav-bench#2 (harness), symnav-bench-runs#2 (workflows + studies); verify merge state before relying on it from `main`. First runs (codex gpt-5.6-terra medium, **one repetition** — pilots, not production statistics):

- `multi-swe-bench-ts-codex-terra-medium-pr94`: 402/402 slots, stock 22.4% vs Symnav 22.9%. Valid.
- `swe-polybench-ts-himid-codex-terra-medium-pr94-r3`: 135 valid slots, stock 35.3% vs Symnav 44.8%, W/T/L 10/53/3. The analysis target for polybench.
- `swe-polybench-...-pr94` (r1) is INVALIDATED (patch capture swept image-baked untracked files → universal apply_failed) and `...-r2` PARTIALLY INVALIDATED (offline verifier vs network-fetching test commands). Both retained immutably with README post-mortems in `studies/`; never analyze them as benchmark data.
- r4 backlog (recorded in symnav-bench-runs README): stretch-archive apt auth for mui-7444, code-server/tailwind log-parser formats (8 symmetrically excluded slots), longer vscode verifier timeout.

Earlier accumulated-cell reports were invalid for causal comparison because they could combine partial task subsets, unrelated configurations, older stock cells, and un-ordered revision SHAs. The study system replaces that design. Do not restore accumulated-cell reporting.

## Statistical analysis

- Pair stock and treatment by task and study configuration. For four trials, compute each task's binary success rate per arm, then macro-average tasks.
- Report treatment score, stock score, percentage-point paired uplift, wins/ties/losses, a paired task-level 95% interval, randomization p-value when available, coverage, and cost/time diagnostics.
- Demonstrated improvement requires the paired interval entirely above zero. Material improvement additionally requires at least +5 percentage points.
- Keep incomplete results visible but label them provisional; do not fill missing trials with zero except outcomes explicitly classified as scored failures.
- Treat command variants as secondary conditions. Give them the same tables, matrix, drill-down, and statistics, while highlighting full Symnav as the primary treatment.
- For product-version comparison, compare each revision's own Symnav uplift against contemporaneous stock. Main revisions are ordered by first-parent history; PR previews use declared evaluation sequence and remain comparable with earlier previews/main where protocol-compatible.

## Study contract

- A study pins benchmark, task selection (SWE-PolyBench tiers), resolved suite (per-task checksums, tiers, image digests), source revision, Symnav SHA, harness image digest, model/effort, randomization, conditions, and repetition policy. Changing any of them is a new study with a new id.
- The Direct-Leaderboard-like protocol is the benchmark's full pinned task set × stock/full Symnav × four trials (DeepSWE: 35 tasks, 280 slots). One-rep studies are cheaper pilots; declare 4-rep studies for production claims.
- Suite resolution for HF-backed benchmarks runs via the `resolve-suite` workflow in symnav-bench-runs CI (local resolution hits HF rate limits); the resolved `suite.json` is committed with the declaration. Workflows read study metadata through the pinned image's `study-metadata` command, with an inline-python fallback for legacy pinned images.
- Primary score is mean binary verifier `reward` over four trials per task. `f2p`, `p2p`, and partial metrics are internal diagnostics.
- Compare only compatible slots in the same study/configuration. Never mix historical stock or partial pilots into the primary comparison.
- A report is provisional until required stock and full-Symnav trials are scored; publish provisional dashboards and state coverage plainly.
- Missing verifier reward is retryable except context exhaustion and agent wall-clock timeout, which are scored failures. Inspect raw exception evidence before classifying failures.

## Results and reporting

Normalized evidence lives on `symnav-bench-runs` branch `results` under `studies/<study-id>/`. Inspect `attempts/`, `data/study.json`, `dashboard/analysis.json`, `dashboard/`, and raw artifact pointers. GitHub Pages serves `studies/<study-id>/`.

Actions dispatcher success only means batches were dispatched. Inspect batch cell jobs and the report job separately. Repeated task-job artifacts from a rerun are valid: report merging must preserve/deduplicate immutable attempts, not reject a repeated logical slot.

If a historical batch report fails, use the `recover study report` workflow with its source run ID, study, configuration, and batch ID. It downloads existing artifacts, merges/reports, and deploys Pages without task cells. Do not dispatch a new batch or rerun cells to repair reporting.

Current report resilience rules: accept repeated logical-slot artifacts from a job rerun; retain distinct immutable attempts; deduplicate byte-equivalent attempts; reject conflicting content for one attempt identity. The `recover study report` workflow exists because GitHub's "rerun job" uses the old workflow revision and therefore cannot receive a later reporting fix.

## Dashboard and publication

Dashboard files are static snapshots written by `symnav-bench`'s report renderer. A renderer/UI change affects new reports only; regenerate a completed study's report from immutable results to refresh its existing Pages URL. The study archive/index is generated by `symnav-bench-runs/.github/workflows/pages.yml`.

Keep the dashboard dense and legible: no green success palette, no nested rounded-card treatment, compact square heatmap cells, matrix-only filters, two-decimal performance scores, explicit chart axes/value labels, and a usable study switcher/archive.

The matrix must make task × model/tool-configuration outcomes easy to scan and expose a cell drawer with all four trials, retry history, metrics, adoption, and raw artifacts. Do not hide partial studies; distinguish them from complete studies with coverage rather than fabricated scores.

## Guardrails

- Do not edit a study's pinned `execution.json` or manifest mid-study. Exception precedent: a harness-image re-pin for resuming unscored slots is acceptable when task materialization is provably unaffected (suite checksums unchanged); document the pin span in the README.
- An environment-invalidated study is terminal: keep its evidence immutable, document the mechanism, and declare a successor (`-r2`, `-r3`) with a re-resolved suite. Never delete, zero, or reinterpret invalid slots in place.
- Do not overwrite or zero-impute raw evidence silently.
- Do not claim improvement from incomplete coverage or unpaired data.
- Run focused tests before pushing; verify the exact Pages/report run after publishing.
- Use the current published image digest for reproducibility; build/publish a new harness image before using changed harness code in a new study.
