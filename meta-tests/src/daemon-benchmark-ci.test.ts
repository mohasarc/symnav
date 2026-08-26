import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("daemon scale benchmark CI", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/daemon-benchmarks.yml"),
    "utf8",
  );
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const cliPackage = JSON.parse(
    readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  it("exposes declarative benchmark and opt-in profiler commands", () => {
    expect(rootPackage.scripts["daemon:benchmark"]).toBe("pnpm --filter symnav daemon:benchmark");
    expect(rootPackage.scripts["daemon:profile"]).toBe("pnpm --filter symnav daemon:profile");
    expect(cliPackage.scripts["daemon:benchmark"]).toBe(
      "tsx test/benchmark/run-daemon-benchmark.ts",
    );
    expect(cliPackage.scripts["daemon:profile"]).toBe("tsx test/benchmark/run-daemon-profile.ts");
  });

  it("blocks on 1x for Ubuntu, Windows, and macOS with a pinned environment", () => {
    const blocking = job("blocking-1x");
    expect(blocking).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(blocking).toContain("node-version-file: .nvmrc");
    expect(blocking).toContain("pnpm install --frozen-lockfile");
    expect(blocking).toContain("pnpm daemon:benchmark --scale 1");
    expect(blocking).toContain("SYMNAV_BENCHMARK_MIN_MEMORY_BYTES: 8589934592");
    expect(blocking).toContain("actions/upload-artifact@v4");
    expect(blocking).not.toContain("continue-on-error");
  });

  it("runs nightly 2x and 3x plus weekly provisioned 10x without partial success", () => {
    expect(workflow).toContain('cron: "0 3 * * *"');
    expect(workflow).toContain('cron: "0 4 * * 0"');
    const nightly = job("nightly-scale");
    expect(nightly).toContain("scale: [2, 3]");
    expect(nightly).toContain("pnpm daemon:benchmark --scale ${{ matrix.scale }}");
    expect(nightly).toContain("actions/upload-artifact@v4");
    expect(nightly).not.toContain("continue-on-error");
    const weekly = job("weekly-10x");
    expect(weekly).toContain("runs-on: [self-hosted, daemon-benchmark-10x]");
    expect(weekly).toContain("SYMNAV_BENCHMARK_MIN_MEMORY_BYTES: 34359738368");
    expect(weekly).toContain("pnpm daemon:benchmark --scale 10");
    expect(weekly).toContain("actions/upload-artifact@v4");
    expect(weekly).not.toContain("continue-on-error");
  });

  function job(name: string): string {
    const start = workflow.indexOf(`  ${name}:`);
    if (start === -1) throw new Error(`Missing workflow job: ${name}`);
    const remaining = workflow.slice(start + name.length + 3);
    const nextJob = remaining.search(/\n  [A-Za-z][\w-]*:/);
    const end = nextJob === -1 ? undefined : start + name.length + 3 + nextJob;
    return workflow.slice(start, end);
  }
});
