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
  | "stale-mutation"
  | "latency-threshold"
  | "status-unresponsive"
  | "daemon-restarted"
  | "fallback-observed"
  | "capacity-result"
  | "raw-runtime-failure"
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
  readonly initialPid: number;
  readonly finalPid: number;
  readonly initialInstanceId: string;
  readonly finalInstanceId: string;
  readonly fallbackCount: number;
  readonly restartCount: number;
  readonly capacityResultCount: number;
  readonly rawRuntimeFailureCount: number;
  readonly processRssPeakBytes: number;
  readonly hardProcessRssBytes: number;
  readonly expectedTelemetryCount: number;
  readonly actualTelemetryCount: number;
  readonly artifactComplete: boolean;
  readonly spoolBytesAfterCleanup: number;
  readonly diagnosticPhasesComplete: boolean;
  readonly generatedVisibleFiles: number;
  readonly expectedVisibleFiles: number;
  readonly mutationsCurrent: boolean;
}

export const DAEMON_BENCHMARK_WARM_REPETITIONS = 9;
export const DAEMON_BENCHMARK_REQUIRED_SAMPLES = 8;
export const DAEMON_BENCHMARK_THRESHOLDS_MS = {
  overview: 500,
  resolve: 2_000,
  def: 2_000,
  refs: 5_000,
  context: 5_000,
  graph: 5_000,
} as const;

export class DaemonBenchmarkGate {
  evaluate(_input: DaemonBenchmarkGateInput): DaemonBenchmarkGateResult {
    throw new Error("Daemon benchmark gate evaluation is not implemented");
  }
}
