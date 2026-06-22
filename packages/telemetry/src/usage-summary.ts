import type { Outcome } from "./usage-event.js";

export interface CommandStat {
  readonly command: string;
  readonly count: number;
  readonly share: number;
}

export interface OutcomeStat {
  readonly outcome: Outcome;
  readonly count: number;
}

export interface DurationStats {
  readonly averageMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface VersionStat {
  readonly version: string;
  readonly count: number;
}

export interface UsageSummary {
  readonly totalEvents: number;
  readonly perCommand: readonly CommandStat[];
  readonly outcomes: readonly OutcomeStat[];
  readonly duration: DurationStats;
  readonly distinctWorkspaces: number;
  readonly versions: readonly VersionStat[];
  readonly dateRange: { readonly earliest: number; readonly latest: number } | null;
}
