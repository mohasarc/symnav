import { describe, expect, it } from "vitest";
import { DaemonBenchmarkRunConfiguration } from "./daemon-benchmark-run-configuration.js";

describe("DaemonBenchmarkRunConfiguration", () => {
  it.each(["1", "2", "3", "10"])("accepts declared scale %s", (scale) => {
    expect(
      DaemonBenchmarkRunConfiguration.parse(["--scale", scale], {}, 64 * 1024 ** 3),
    ).toMatchObject({ scale: Number(scale), artifactDirectory: "artifacts" });
  });

  it.each([
    [],
    ["--scale"],
    ["--scale", "4"],
    ["--scale", "1", "extra"],
  ])("rejects partial or unknown arguments %#", (argv) => {
    expect(() => DaemonBenchmarkRunConfiguration.parse(argv, {}, 64 * 1024 ** 3)).toThrow(
      "Usage: pnpm daemon:benchmark --scale <1|2|3|10>",
    );
  });

  it("fails before generation when the effective runner memory is undersized", () => {
    expect(() =>
      DaemonBenchmarkRunConfiguration.parse(
        ["--scale", "10"],
        { SYMNAV_BENCHMARK_MIN_MEMORY_BYTES: String(32 * 1024 ** 3) },
        64 * 1024 ** 3,
        16 * 1024 ** 3,
      ),
    ).toThrow("Daemon benchmark runner memory is undersized");
  });

  it("honors an explicit aggregate artifact directory", () => {
    expect(
      DaemonBenchmarkRunConfiguration.parse(
        ["--scale", "1"],
        { SYMNAV_BENCHMARK_ARTIFACT_DIR: "benchmark-output" },
        64 * 1024 ** 3,
      ).artifactDirectory,
    ).toBe("benchmark-output");
  });
});
