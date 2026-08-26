# Daemon scale benchmarks

Build the CLI before running a benchmark. The benchmark generates a deterministic connected
workspace from the reviewed aggregate profile and writes its gate artifact under `artifacts/`.

```sh
pnpm build
pnpm daemon:benchmark --scale 1
pnpm daemon:benchmark --scale 2
pnpm daemon:benchmark --scale 3
pnpm daemon:benchmark --scale 10
```

The 1x, 2x, and 3x runners require at least 8 GiB of effective memory. The provisioned 10x runner
requires at least 32 GiB. `SYMNAV_BENCHMARK_MIN_MEMORY_BYTES` can raise the requirement for a
specific runner. An undersized runner fails before generation.

Local profiling is opt-in and emits only the versioned aggregate schema. Review the output before
replacing the checked-in profile.

```sh
pnpm daemon:profile --workspace <local-path>
```
