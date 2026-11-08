# Contributing

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

Build before testing: e2e tests spawn the built `apps/cli/dist/cli.js`, not source.

Run the CLI from source with `tsx`, no build step. It runs in `apps/cli`, so paths are relative to that folder:

```sh
pnpm --filter symnav dev --version
pnpm --filter symnav dev overview src/program.ts
```

## Checks

CI runs this sequence. Run it on a clean tree before opening or updating a PR:

```sh
pnpm install --frozen-lockfile && pnpm build && pnpm test \
  && pnpm --filter symnav test:e2e:cold && pnpm --filter symnav test:e2e:warm \
  && pnpm lint && pnpm typecheck
```

`--frozen-lockfile` is the only step that catches lockfile drift.

## Sandbox checks

Real sandbox checks use the pinned `@anthropic-ai/sandbox-runtime` on macOS and Linux, which needs Node 22.12 or newer. Linux also needs `bubblewrap`, `socat`, `ripgrep`, and working unprivileged user namespaces. After building:

```sh
pnpm --filter symnav exec vitest run test/e2e/sandbox/warm-navigation.test.ts test/e2e/sandbox/doctor.test.ts
```

Set `SYMNAV_REQUIRE_SANDBOX_RUNTIME=1` to fail instead of skip when prerequisites are missing. CI sets it on both platforms and uses Node 22 for sandbox jobs; everything else runs on Node 20. An installed Codex runs the same checks with an isolated config.

## Pull requests

PRs are squash-merged, so the PR title becomes the commit on `main` and drives the release version. Titles need a conventional type and no scope: `feat: Add regex targets`. Types: `feat`, `fix`, `perf`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`; `!` after the type marks a breaking change.

## License

symnav is Apache-2.0. Contributions are accepted under the same license with a [Developer Certificate of Origin](https://developercertificate.org/) sign-off. Sign off every commit with `git commit -s`, which adds:

```text
Signed-off-by: Your Name <you@example.com>
```
