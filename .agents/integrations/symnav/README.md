# Agent integration bundles

`catalog.json` is the versioned contract for benchmark agent integration. Consumers must check out an exact symnav revision before loading it. A symnav SHA now pins CLI code, agent guidance, command access, and Claude hooks together.

## Selecting a bundle

1. Reject unknown `schemaVersion` values.
2. Resolve every catalog path relative to repository root. Reject missing files, non-regular files, and paths that leave repository.
3. Apply `sharedRulesFile` to every arm, including stock. It contains runtime guidance only.
4. For a symnav arm, select one bundle by exact `id`. Copy its skill directory, rules, Claude settings, and Claude hook without combining assets from other bundles.
5. Expose only commands listed in `allowedCommands`. `full` is product integration. Other bundles are diagnostic treatments.

Keep repository-relative asset paths stable when injecting a bundle. Rules point agents at selected skill using those paths. Variant skills live below `variants/`, so installing symnav outside benchmark does not expose them as normal skills.

Claude settings expect selected hook at `/tmp/symnav-bench/symnav-nudge.js`. Copy `claudeHookFile` there before starting agent. Codex ignores Claude-only assets.

Stock arms consume shared rules only. They must not receive bundle rules, skills, hooks, or command access.
