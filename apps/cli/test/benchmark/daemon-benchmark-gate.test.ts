import { describe, expect, it } from "vitest";
import {
  DAEMON_BENCHMARK_WARM_REPETITIONS,
  DaemonBenchmarkGate,
  type DaemonBenchmarkFailureCode,
  type DaemonBenchmarkGateInput,
  type DaemonBenchmarkSample,
} from "./daemon-benchmark-gate.js";

describe("DaemonBenchmarkGate", () => {
  it("uses all nine queue-independent service samples for strict statistics", () => {
    const input = BenchmarkEvidence.valid();
    const samples = BenchmarkEvidence.samples([1, 2, 3, 4, 5, 6, 7, 8, 9], 100_000);

    const result = new DaemonBenchmarkGate().evaluate({ ...input, samples });

    expect(result.commandStatistics.overview).toEqual({
      minimumMs: 1,
      p50Ms: 5,
      p95Ms: 9,
      maximumMs: 9,
      samplesMeetingThreshold: 9,
    });
    expect(result.passed).toBe(true);
  });

  it("requires the median and at least eight of nine 1x samples", () => {
    const gate = new DaemonBenchmarkGate();
    const eightPassing = BenchmarkEvidence.samples([100, 100, 100, 100, 100, 100, 100, 100, 900]);
    const sevenPassing = BenchmarkEvidence.samples([100, 100, 100, 100, 100, 100, 100, 900, 900]);

    expect(gate.evaluate({ ...BenchmarkEvidence.valid(), samples: eightPassing }).passed).toBe(
      true,
    );
    expect(
      gate.evaluate({ ...BenchmarkEvidence.valid(), samples: sevenPassing }).failures,
    ).toContain("latency-threshold");
  });

  it.each(BenchmarkEvidence.failures)("fails independently for %s", (failure, mutate) => {
    const input = mutate(BenchmarkEvidence.valid());

    const result = new DaemonBenchmarkGate().evaluate(input);

    expect(result.failures).toEqual([failure]);
    expect(result.passed).toBe(false);
  });
});

class BenchmarkEvidence {
  static readonly failures: readonly [
    DaemonBenchmarkFailureCode,
    (input: DaemonBenchmarkGateInput) => DaemonBenchmarkGateInput,
  ][] = [
    ["stdout-mismatch", (input) => ({ ...input, stdoutParity: false })],
    ["stderr-mismatch", (input) => ({ ...input, stderrParity: false })],
    ["exit-mismatch", (input) => ({ ...input, exitParity: false })],
    ["alias-result-empty", (input) => ({ ...input, aliasResultsNonEmpty: false })],
    ["stale-mutation", (input) => ({ ...input, mutationsCurrent: false })],
    ["latency-threshold", (input) => ({ ...input, samples: this.samples(Array(9).fill(501)) })],
    ["status-unresponsive", (input) => ({ ...input, statusMaximumMs: 1_001 })],
    ["daemon-restarted", (input) => ({ ...input, restartCount: 1 })],
    ["fallback-observed", (input) => ({ ...input, fallbackCount: 1 })],
    ["capacity-result", (input) => ({ ...input, capacityResultCount: 1 })],
    ["raw-runtime-failure", (input) => ({ ...input, rawRuntimeFailureCount: 1 })],
    ["large-response-incomplete", (input) => ({ ...input, largeResponseBytes: 8 * 1024 * 1024 })],
    ["rss-limit", (input) => ({ ...input, processRssPeakBytes: input.hardProcessRssBytes })],
    ["telemetry-count", (input) => ({ ...input, actualTelemetryCount: 10 })],
    ["missing-sample", (input) => ({ ...input, samples: input.samples.slice(1) })],
    ["missing-artifact", (input) => ({ ...input, artifactComplete: false })],
    ["spool-leak", (input) => ({ ...input, spoolBytesAfterCleanup: 1 })],
    ["identity-discontinuity", (input) => ({ ...input, finalInstanceId: "replacement" })],
    ["diagnostic-phase-missing", (input) => ({ ...input, diagnosticPhasesComplete: false })],
    ["undersized-run", (input) => ({ ...input, generatedVisibleFiles: 11 })],
  ];

  static valid(): DaemonBenchmarkGateInput {
    return {
      scale: 1,
      samples: this.samples(Array(DAEMON_BENCHMARK_WARM_REPETITIONS).fill(100)),
      expectedCommands: ["overview"],
      stdoutParity: true,
      stderrParity: true,
      exitParity: true,
      aliasResultsNonEmpty: true,
      freshness: true,
      statusMaximumMs: 100,
      initialPid: 123,
      finalPid: 123,
      initialInstanceId: "stable",
      finalInstanceId: "stable",
      fallbackCount: 0,
      restartCount: 0,
      capacityResultCount: 0,
      rawRuntimeFailureCount: 0,
      largeResponseBytes: 8 * 1024 * 1024 + 1,
      processRssPeakBytes: 100,
      hardProcessRssBytes: 1_000,
      expectedTelemetryCount: 9,
      actualTelemetryCount: 9,
      artifactComplete: true,
      spoolBytesAfterCleanup: 0,
      diagnosticPhasesComplete: true,
      generatedVisibleFiles: 12,
      expectedVisibleFiles: 12,
      mutationsCurrent: true,
    };
  }

  static samples(
    serviceTimes: readonly number[],
    queueWaitMs = 0,
  ): readonly DaemonBenchmarkSample[] {
    return serviceTimes.map((serviceMsExcludingQueue, repetition) => ({
      command: "overview",
      repetition,
      serviceMsExcludingQueue,
      queueWaitMs,
      stdoutDigest: "stdout",
      stderrDigest: "stderr",
      exitCode: 0,
      responseBytes: 10,
      processRssPeakBytes: 100,
      spoolPeakBytes: 0,
    }));
  }
}
