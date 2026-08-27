import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonBenchmarkFailureReporter } from "./daemon-benchmark-failure-reporter.js";
import { DaemonBenchmarkRunConfiguration } from "./daemon-benchmark-run-configuration.js";

describe("DaemonBenchmarkFailureReporter", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("writes closed benchmark provenance before preserving an execution failure", async () => {
    const artifactDirectory = mkdtempSync(join(tmpdir(), "symnav-benchmark-failure-"));
    directories.push(artifactDirectory);
    const configuration = DaemonBenchmarkRunConfiguration.parse(
      ["--scale", "1"],
      { SYMNAV_BENCHMARK_ARTIFACT_DIR: artifactDirectory },
      16 * 1024 ** 3,
    );
    const reporter = new DaemonBenchmarkFailureReporter(configuration, artifactDirectory, {
      platform: "win32",
      architecture: "x64",
      nodeVersion: "v22.0.0",
    });

    const originalError = new Error("startup failed with secret-token");
    originalError.name = "SecretBearingError";
    await expect(reporter.run({ run: () => Promise.reject(originalError) })).rejects.toBe(
      originalError,
    );

    const serializedArtifact = readFileSync(
      join(artifactDirectory, "daemon-benchmark-1x-win32.failure.json"),
      "utf8",
    );
    const artifact = JSON.parse(serializedArtifact) as Record<string, unknown>;
    expect(artifact).toEqual({
      schemaVersion: 1,
      kind: "daemon-benchmark-failure",
      scale: 1,
      platform: "win32",
      architecture: "x64",
      nodeVersion: "v22.0.0",
      stage: "benchmark-execution",
      reason: "benchmark-execution-failed",
      errorName: "UnknownError",
    });
    expect(serializedArtifact).not.toContain("secret-token");
    expect(serializedArtifact).not.toContain("startup failed");
    expect(serializedArtifact).not.toContain("SecretBearingError");
  });

  it("preserves the execution failure when its artifact cannot be written", async () => {
    const artifactDirectory = mkdtempSync(join(tmpdir(), "symnav-benchmark-failure-"));
    directories.push(artifactDirectory);
    const configuration = DaemonBenchmarkRunConfiguration.parse(
      ["--scale", "1"],
      { SYMNAV_BENCHMARK_ARTIFACT_DIR: artifactDirectory },
      16 * 1024 ** 3,
    );
    mkdirSync(join(artifactDirectory, `daemon-benchmark-1x-${process.platform}.failure.json`));
    const reporter = new DaemonBenchmarkFailureReporter(configuration, artifactDirectory);
    const originalError = new Error("original benchmark failure");

    await expect(reporter.run({ run: () => Promise.reject(originalError) })).rejects.toBe(
      originalError,
    );
  });
});
