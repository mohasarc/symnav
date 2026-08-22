import type { BackendRefreshSummary } from "@symnav/core";

export interface DaemonBenchmarkMeasurement {
  readonly fileCount: number;
  readonly counts: {
    readonly projectLoads: number;
    readonly snapshots: number;
    readonly refreshes: number;
  };
  readonly refreshes: readonly BackendRefreshSummary[];
  readonly firstResolveMs: number;
  readonly secondResolveMs: number;
  readonly target: DaemonBenchmarkTargetComparison;
}

export interface DaemonBenchmarkTargetComparison {
  readonly secondResolveMs: number;
  readonly minimumFirstToSecondRatio: number;
  readonly secondResolveMet: boolean;
  readonly firstToSecondRatioMet: boolean;
  readonly wallClockGated: false;
}
