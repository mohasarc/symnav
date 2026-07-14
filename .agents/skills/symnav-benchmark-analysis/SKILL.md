---
name: symnav-benchmark-analysis
description: Continue, analyze, operate, or recover Symnav benchmark studies across the symnav product, symnav-bench harness, and symnav-bench-runs GitHub Actions/results repositories. Use for new experiments, study reports, dashboard work, benchmark recovery, statistical analysis, or GitHub Pages publication.
---

# Symnav benchmark analysis

Treat a study—not a GitHub Actions run—as the analytical unit. Preserve immutable task evidence and do not rerun task cells merely to repair reporting.

## What this program is proving

The headline question is causal: for a fixed coding agent, model, and effort level, does adding full Symnav cause the agent to fully solve more DeepSWE TypeScript tasks than stock? The public-facing score must be comparable in spirit to SWE-Deep: each task receives 0%, 25%, 50%, 75%, or 100% from four independent binary verifier rewards, then task scores are macro-averaged.

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
- `symnav-bench` owns agent execution, DeepSWE access, trial normalization, trajectory extraction, paired statistics, CSV/Parquet exports, and the static dashboard bundle. Its Docker image is immutable for a study.
- `symnav-bench-runs` owns declared studies under `studies/`, GitHub Actions batch execution, and public result publication. Its `results` branch is the canonical normalized evidence store; Pages copies dashboards from that branch.
- A GitHub batch may be split for the Actions matrix limit. Batches are execution shards, not separate experiments. A model configuration is complete only after all its planned slots are represented in the same study.

## Known historical state

The first production-style reference study was `deepswe-ts-codex-terra-medium-pr94`: 35 TypeScript tasks, stock versus full Symnav, four trials, 280 planned slots. Its recovered complete report showed stock 33.57% and Symnav 35.71%. Treat this as one estimate, not proof by itself. A lower-cost Codex study with the same product revision/protocol was subsequently created as `deepswe-ts-codex-terra-low-pr94`; always inspect its live coverage and normalized evidence rather than assuming completion.

Earlier accumulated-cell reports were invalid for causal comparison because they could combine partial task subsets, unrelated configurations, older stock cells, and un-ordered revision SHAs. The study system replaces that design. Do not restore accumulated-cell reporting.

## Statistical analysis

- Pair stock and treatment by task and study configuration. For four trials, compute each task's binary success rate per arm, then macro-average tasks.
- Report treatment score, stock score, percentage-point paired uplift, wins/ties/losses, a paired task-level 95% interval, randomization p-value when available, coverage, and cost/time diagnostics.
- Demonstrated improvement requires the paired interval entirely above zero. Material improvement additionally requires at least +5 percentage points.
- Keep incomplete results visible but label them provisional; do not fill missing trials with zero except outcomes explicitly classified as scored failures.
- Treat command variants as secondary conditions. Give them the same tables, matrix, drill-down, and statistics, while highlighting full Symnav as the primary treatment.
- For product-version comparison, compare each revision's own Symnav uplift against contemporaneous stock. Main revisions are ordered by first-parent history; PR previews use declared evaluation sequence and remain comparable with earlier previews/main where protocol-compatible.

## Study contract

- A study pins suite, DeepSWE SHA, Symnav SHA, harness image digest, model/effort, randomization, conditions, and repetition policy.
- The current Direct-Leaderboard-like protocol is every TypeScript task (currently 35) × stock/full Symnav × four trials: 280 slots per model configuration.
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

- Do not edit a study's pinned `execution.json` or manifest mid-study.
- Do not overwrite or zero-impute raw evidence silently.
- Do not claim improvement from incomplete coverage or unpaired data.
- Run focused tests before pushing; verify the exact Pages/report run after publishing.
- Use the current published image digest for reproducibility; build/publish a new harness image before using changed harness code in a new study.
