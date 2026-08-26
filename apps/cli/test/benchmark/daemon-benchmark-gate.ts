import type { DaemonCommandName } from "../../src/daemon/daemon-protocol.js";
import type { DaemonBenchmarkScale } from "./daemon-workspace-generator.js";

export interface DaemonBenchmarkSample {
  readonly command: DaemonCommandName;
  readonly repetition: number;
  readonly serviceMsExcludingQueue: number;
  readonly queueWaitMs: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly exitCode: number;
  readonly responseBytes: number;
  readonly processRssPeakBytes: number;
  readonly workerHeapPeakBytes?: number;
  readonly spoolPeakBytes: number;
}

export interface DaemonBenchmarkStatistics {
  readonly minimumMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
  readonly samplesMeetingThreshold: number;
}

export type DaemonBenchmarkFailureCode =
  | "stdout-mismatch"
  | "stderr-mismatch"
  | "exit-mismatch"
  | "alias-result-empty"
  | "semantic-result-mismatch"
  | "stale-mutation"
  | "latency-threshold"
  | "status-unresponsive"
  | "busy-status-missing"
  | "daemon-restarted"
  | "fallback-observed"
  | "capacity-result"
  | "raw-runtime-failure"
  | "large-response-incomplete"
  | "rss-limit"
  | "telemetry-count"
  | "missing-sample"
  | "missing-artifact"
  | "spool-leak"
  | "identity-discontinuity"
  | "diagnostic-phase-missing"
  | "undersized-run";

export interface DaemonBenchmarkGateResult {
  readonly passed: boolean;
  readonly failures: readonly DaemonBenchmarkFailureCode[];
  readonly commandStatistics: Readonly<Record<string, DaemonBenchmarkStatistics>>;
  readonly parity: boolean;
  readonly freshness: boolean;
  readonly statusResponsive: boolean;
  readonly continuity: boolean;
  readonly exactlyOnceTelemetry: boolean;
  readonly resourcesWithinPolicy: boolean;
  readonly spoolsCleaned: boolean;
}

export interface DaemonBenchmarkGateInput {
  readonly scale: DaemonBenchmarkScale;
  readonly samples: readonly DaemonBenchmarkSample[];
  readonly expectedCommands: readonly DaemonCommandName[];
  readonly stdoutParity: boolean;
  readonly stderrParity: boolean;
  readonly exitParity: boolean;
  readonly aliasResultsNonEmpty: boolean;
  readonly freshness: boolean;
  readonly statusMaximumMs: number;
  readonly busyStatusObserved: boolean;
  readonly initialPid: number;
  readonly finalPid: number;
  readonly initialInstanceId: string;
  readonly finalInstanceId: string;
  readonly fallbackCount: number;
  readonly restartCount: number;
  readonly capacityResultCount: number;
  readonly rawRuntimeFailureCount: number;
  readonly largeResponseBytes: number;
  readonly processRssPeakBytes: number;
  readonly hardProcessRssBytes: number;
  readonly expectedTelemetryCount: number;
  readonly actualTelemetryCount: number;
  readonly expectedTelemetryCommands: readonly DaemonCommandName[];
  readonly actualTelemetryCommands: readonly DaemonCommandName[];
  readonly artifactComplete: boolean;
  readonly spoolBytesAfterCleanup: number;
  readonly diagnosticPhasesComplete: boolean;
  readonly generatedVisibleFiles: number;
  readonly expectedVisibleFiles: number;
  readonly mutationsCurrent: boolean;
}

export const DAEMON_BENCHMARK_WARM_REPETITIONS = 9;
export const DAEMON_BENCHMARK_REQUIRED_SAMPLES = 8;
export const DAEMON_BENCHMARK_LARGE_RESPONSE_MINIMUM_BYTES = 8 * 1024 * 1024;
export const DAEMON_BENCHMARK_THRESHOLDS_MS = {
  overview: 500,
  resolve: 2_000,
  def: 2_000,
  refs: 5_000,
  context: 5_000,
  graph: 5_000,
} as const;

export class DaemonBenchmarkGate {
  evaluate(input: DaemonBenchmarkGateInput): DaemonBenchmarkGateResult {
    const commandStatistics: Record<string, DaemonBenchmarkStatistics> = {};
    let latencyMet = true;
    let samplesComplete = true;
    for (const command of input.expectedCommands) {
      const samples = input.samples
        .filter((sample) => sample.command === command)
        .sort((left, right) => left.repetition - right.repetition);
      if (
        samples.length !== DAEMON_BENCHMARK_WARM_REPETITIONS ||
        samples.some((sample, repetition) => sample.repetition !== repetition)
      ) {
        samplesComplete = false;
      }
      if (samples.length === 0) continue;
      const threshold = DaemonBenchmarkGate.threshold(command);
      const statistics = DaemonBenchmarkGate.statistics(samples, threshold);
      commandStatistics[command] = statistics;
      if (
        input.scale === 1 &&
        threshold !== undefined &&
        (statistics.p50Ms > threshold ||
          statistics.samplesMeetingThreshold < DAEMON_BENCHMARK_REQUIRED_SAMPLES)
      ) {
        latencyMet = false;
      }
    }

    const parity = input.stdoutParity && input.stderrParity && input.exitParity;
    const freshness = input.freshness && input.mutationsCurrent;
    const statusResponsive = input.statusMaximumMs < 1_000;
    const continuity =
      input.restartCount === 0 &&
      input.initialPid === input.finalPid &&
      input.initialInstanceId === input.finalInstanceId;
    const exactlyOnceTelemetry =
      input.actualTelemetryCount === input.expectedTelemetryCount &&
      input.actualTelemetryCommands.length === input.expectedTelemetryCommands.length &&
      input.actualTelemetryCommands.every(
        (command, index) => command === input.expectedTelemetryCommands[index],
      );
    const resourcesWithinPolicy = input.processRssPeakBytes < input.hardProcessRssBytes;
    const spoolsCleaned = input.spoolBytesAfterCleanup === 0;
    const failures: DaemonBenchmarkFailureCode[] = [];
    if (!input.stdoutParity) failures.push("stdout-mismatch");
    if (!input.stderrParity) failures.push("stderr-mismatch");
    if (!input.exitParity) failures.push("exit-mismatch");
    if (!input.aliasResultsNonEmpty) failures.push("alias-result-empty");
    if (!freshness) failures.push("stale-mutation");
    if (!latencyMet) failures.push("latency-threshold");
    if (!statusResponsive) failures.push("status-unresponsive");
    if (!input.busyStatusObserved) failures.push("busy-status-missing");
    if (input.restartCount > 0) failures.push("daemon-restarted");
    if (input.fallbackCount > 0) failures.push("fallback-observed");
    if (input.capacityResultCount > 0) failures.push("capacity-result");
    if (input.rawRuntimeFailureCount > 0) failures.push("raw-runtime-failure");
    if (input.largeResponseBytes <= DAEMON_BENCHMARK_LARGE_RESPONSE_MINIMUM_BYTES) {
      failures.push("large-response-incomplete");
    }
    if (!resourcesWithinPolicy) failures.push("rss-limit");
    if (!exactlyOnceTelemetry) failures.push("telemetry-count");
    if (!samplesComplete) failures.push("missing-sample");
    if (!input.artifactComplete) failures.push("missing-artifact");
    if (!spoolsCleaned) failures.push("spool-leak");
    if (input.initialPid !== input.finalPid || input.initialInstanceId !== input.finalInstanceId) {
      failures.push("identity-discontinuity");
    }
    if (!input.diagnosticPhasesComplete) failures.push("diagnostic-phase-missing");
    if (input.generatedVisibleFiles < input.expectedVisibleFiles) failures.push("undersized-run");
    return {
      passed: failures.length === 0,
      failures,
      commandStatistics,
      parity,
      freshness,
      statusResponsive,
      continuity,
      exactlyOnceTelemetry,
      resourcesWithinPolicy,
      spoolsCleaned,
    };
  }

  private static threshold(command: DaemonCommandName): number | undefined {
    if (command in DAEMON_BENCHMARK_THRESHOLDS_MS) {
      return DAEMON_BENCHMARK_THRESHOLDS_MS[command as keyof typeof DAEMON_BENCHMARK_THRESHOLDS_MS];
    }
    return undefined;
  }

  private static statistics(
    samples: readonly DaemonBenchmarkSample[],
    threshold: number | undefined,
  ): DaemonBenchmarkStatistics {
    const values = samples
      .map((sample) => sample.serviceMsExcludingQueue)
      .sort((left, right) => left - right);
    return {
      minimumMs: values[0]!,
      p50Ms: values[Math.ceil(values.length * 0.5) - 1]!,
      p95Ms: values[Math.ceil(values.length * 0.95) - 1]!,
      maximumMs: values.at(-1)!,
      samplesMeetingThreshold:
        threshold === undefined
          ? values.length
          : values.filter((value) => value <= threshold).length,
    };
  }
}
