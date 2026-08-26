import { describe, expect, it } from "vitest";
import { DaemonBenchmarkRunConfiguration } from "./daemon-benchmark-run-configuration.js";

describe("DaemonBenchmarkRunConfiguration", () => {
  it.each(["1", "2", "3", "10"])("accepts declared scale %s", (scale) => {
    expect(
      DaemonBenchmarkRunConfiguration.parse(["--scale", scale], {}, 64 * 1024 ** 3),
    ).toMatchObject({ scale: Number(scale), artifactDirectory: "artifacts" });
  });

  it.each([
    { argv: [] },
    { argv: ["--scale"] },
    { argv: ["--scale", "4"] },
    { argv: ["--scale", "1", "extra"] },
  ])("rejects partial or unknown arguments %#", ({ argv }) => {
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

  it.each([
    { scale: "1", systemMemoryBytes: 4 * 1024 ** 3 },
    { scale: "10", systemMemoryBytes: 16 * 1024 ** 3 },
  ])("does not let the environment lower the $scale x memory floor", (input) => {
    expect(() =>
      DaemonBenchmarkRunConfiguration.parse(
        ["--scale", input.scale],
        { SYMNAV_BENCHMARK_MIN_MEMORY_BYTES: "1" },
        input.systemMemoryBytes,
      ),
    ).toThrow("Daemon benchmark runner memory is undersized");
  });

  it("lets the environment raise the declared memory floor", () => {
    expect(() =>
      DaemonBenchmarkRunConfiguration.parse(
        ["--scale", "1"],
        { SYMNAV_BENCHMARK_MIN_MEMORY_BYTES: String(40 * 1024 ** 3) },
        32 * 1024 ** 3,
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
