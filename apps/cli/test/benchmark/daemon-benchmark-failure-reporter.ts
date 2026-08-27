import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonBenchmarkRunConfiguration } from "./daemon-benchmark-run-configuration.js";

interface DaemonBenchmarkExecution<Result> {
  run(): Promise<Result>;
}

interface DaemonBenchmarkRuntimeIdentity {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeVersion: string;
}

interface DaemonBenchmarkFailureArtifact {
  readonly schemaVersion: 1;
  readonly kind: "daemon-benchmark-failure";
  readonly scale: DaemonBenchmarkRunConfiguration["scale"];
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly stage: "benchmark-execution";
  readonly reason: "benchmark-execution-failed";
  readonly errorName: "Error" | "TypeError" | "RangeError" | "SyntaxError" | "UnknownError";
}

export class DaemonBenchmarkFailureReporter {
  constructor(
    private readonly configuration: DaemonBenchmarkRunConfiguration,
    private readonly artifactDirectory: string,
    private readonly runtime: DaemonBenchmarkRuntimeIdentity = {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
    },
  ) {}

  async run<Result>(execution: DaemonBenchmarkExecution<Result>): Promise<Result> {
    mkdirSync(this.artifactDirectory, { recursive: true });
    try {
      return await execution.run();
    } catch (error) {
      try {
        this.writeFailure(error);
      } catch {}
      throw error;
    }
  }

  private writeFailure(error: unknown): void {
    const artifact: DaemonBenchmarkFailureArtifact = {
      schemaVersion: 1,
      kind: "daemon-benchmark-failure",
      scale: this.configuration.scale,
      platform: this.runtime.platform,
      architecture: this.runtime.architecture,
      nodeVersion: this.runtime.nodeVersion,
      stage: "benchmark-execution",
      reason: "benchmark-execution-failed",
      errorName: DaemonBenchmarkFailureReporter.errorName(error),
    };
    const artifactPath = join(
      this.artifactDirectory,
      `daemon-benchmark-${this.configuration.scale}x-${this.runtime.platform}.failure.json`,
    );
    writeFileSync(artifactPath, `${JSON.stringify(artifact, undefined, 2)}\n`, "utf8");
  }

  private static errorName(error: unknown): DaemonBenchmarkFailureArtifact["errorName"] {
    if (!(error instanceof Error)) return "UnknownError";
    if (
      error.name === "Error" ||
      error.name === "TypeError" ||
      error.name === "RangeError" ||
      error.name === "SyntaxError"
    ) {
      return error.name;
    }
    return "UnknownError";
  }
}
