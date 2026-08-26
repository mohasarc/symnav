import type { DaemonResourcePolicyRecord } from "../../src/daemon/daemon-resource-monitor.js";
import type {
  DaemonBenchmarkGateResult,
  DaemonBenchmarkSample,
  DaemonBenchmarkStatistics,
} from "./daemon-benchmark-gate.js";
import type { DaemonBenchmarkScale } from "./daemon-workspace-generator.js";
import type { DaemonWorkspaceProfile } from "./daemon-workspace-profile.js";

export interface DaemonBenchmarkHarnessOptions {
  readonly profile: DaemonWorkspaceProfile;
  readonly scale: DaemonBenchmarkScale;
  readonly generatorVersion: string;
  readonly seed: string;
  readonly workspaceRoot?: string;
  readonly stateDirectory?: string;
}

export interface DaemonBenchmarkArtifact {
  readonly schemaVersion: 1;
  readonly profileVersion: string;
  readonly generatorVersion: string;
  readonly seed: string;
  readonly scale: DaemonBenchmarkScale;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly cpuCount: number;
  readonly resourcePolicy: DaemonResourcePolicyRecord;
  readonly startupMs: number;
  readonly commandStatistics: Readonly<Record<string, DaemonBenchmarkStatistics>>;
  readonly processRssPeakBytes: number;
  readonly workerHeapPeakBytes?: number;
  readonly spoolPeakBytes: number;
  readonly responsePeakBytes: number;
  readonly parity: boolean;
  readonly freshness: boolean;
  readonly statusResponsive: boolean;
  readonly continuity: boolean;
  readonly exactlyOnceTelemetry: boolean;
  readonly resourcesWithinPolicy: boolean;
  readonly spoolsCleaned: boolean;
  readonly failures: DaemonBenchmarkGateResult["failures"];
  readonly samples: readonly DaemonBenchmarkSample[];
}

export class DaemonScaleBenchmarkHarness {
  constructor(private readonly options: DaemonBenchmarkHarnessOptions) {}

  run(): Promise<DaemonBenchmarkArtifact> {
    return Promise.reject(new Error("Daemon scale benchmark harness is not implemented"));
  }
}
