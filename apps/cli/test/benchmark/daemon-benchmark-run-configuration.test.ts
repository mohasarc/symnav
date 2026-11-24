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

  it("runs the TypeScript profile by default", () => {
    const configuration = DaemonBenchmarkRunConfiguration.parse(
      ["--scale", "1"],
      {},
      64 * 1024 ** 3,
    );

    expect(configuration.profile).toBe("typescript");
    expect(configuration.profileFileName).toBe("daemon-workspace-1x.v1.json");
    expect(configuration.artifactFileName("linux")).toBe("daemon-benchmark-1x-linux.json");
  });

  it.each([
    ["--scale", "2", "--profile", "javascript"],
    ["--profile", "javascript", "--scale", "2"],
  ])("selects the JavaScript profile and names its artifact %#", (...argv) => {
    const configuration = DaemonBenchmarkRunConfiguration.parse(argv, {}, 64 * 1024 ** 3);

    expect(configuration.scale).toBe(2);
    expect(configuration.profile).toBe("javascript");
    expect(configuration.profileFileName).toBe("daemon-workspace-js-1x.v1.json");
    expect(configuration.artifactFileName("win32")).toBe(
      "daemon-benchmark-javascript-2x-win32.json",
    );
  });

  it.each([
    { argv: ["--scale", "1", "--profile"] },
    { argv: ["--scale", "1", "--profile", "python"] },
    { argv: ["--scale", "1", "--profile", "javascript", "--profile", "typescript"] },
    { argv: ["--profile", "javascript"] },
  ])("rejects a partial or unknown profile %#", ({ argv }) => {
    expect(() => DaemonBenchmarkRunConfiguration.parse(argv, {}, 64 * 1024 ** 3)).toThrow(
      "Usage: pnpm daemon:benchmark --scale <1|2|3|10> [--profile <typescript|javascript>]",
    );
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
