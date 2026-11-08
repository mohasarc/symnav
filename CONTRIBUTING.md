# Contributing

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

Build before testing: e2e tests spawn the built `apps/cli/dist/cli.js`, not source.

Run the CLI from source with `tsx`, no build step:

```sh
pnpm --filter symnav dev --version
```

## Sandbox checks

Real sandbox checks use the pinned `@anthropic-ai/sandbox-runtime` on macOS and Linux, which needs Node 22.12 or newer. Linux also needs `bubblewrap`, `socat`, `ripgrep`, and working unprivileged user namespaces. After building:

```sh
pnpm --filter symnav exec vitest run test/e2e/sandbox/warm-navigation.test.ts test/e2e/sandbox/doctor.test.ts
```

Set `SYMNAV_REQUIRE_SANDBOX_RUNTIME=1` to fail instead of skip when prerequisites are missing. CI sets it on both platforms and uses Node 22 for sandbox jobs; everything else runs on Node 20. An installed Codex runs the same checks with an isolated config.
