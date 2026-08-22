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

interface BenchmarkCounters {
  projectLoads: number;
  readonly refreshes: BackendRefreshSummary[];
}

export interface DaemonBenchmarkTargetComparison {
  readonly secondResolveMs: number;
  readonly minimumFirstToSecondRatio: number;
  readonly secondResolveMet: boolean;
  readonly firstToSecondRatioMet: boolean;
  readonly wallClockGated: false;
}

export class DaemonBenchmarkTarget {
  constructor(
    private readonly secondResolveThresholdMs = 200,
    private readonly minimumFirstToSecondRatio = 2,
  ) {}

  compare(firstResolveMs: number, secondResolveMs: number): DaemonBenchmarkTargetComparison {
    const ratio =
      secondResolveMs === 0 ? Number.POSITIVE_INFINITY : firstResolveMs / secondResolveMs;
    return {
      secondResolveMs: this.secondResolveThresholdMs,
      minimumFirstToSecondRatio: this.minimumFirstToSecondRatio,
      secondResolveMet: secondResolveMs < this.secondResolveThresholdMs,
      firstToSecondRatioMet: ratio >= this.minimumFirstToSecondRatio,
      wallClockGated: false,
    };
  }
}
