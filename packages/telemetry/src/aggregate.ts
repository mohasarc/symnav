import type { UsageEvent } from "./usage-event.js";
import type { CommandStat, OutcomeStat, UsageSummary, VersionStat } from "./usage-summary.js";

export function aggregate(events: readonly UsageEvent[]): UsageSummary {
  if (events.length === 0) {
    return emptyUsageSummary();
  }

  const durations = events.map((event) => event.durationMs).sort((left, right) => left - right);
  const timestamps = events.map((event) => event.timestamp);

  return {
    totalEvents: events.length,
    perCommand: commandStats(events),
    outcomes: outcomeStats(events),
    duration: {
      averageMs: durations.reduce((sum, durationMs) => sum + durationMs, 0) / durations.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    },
    distinctWorkspaces: new Set(events.map((event) => event.workspaceId)).size,
    versions: versionStats(events),
    dateRange: {
      earliest: Math.min(...timestamps),
      latest: Math.max(...timestamps),
    },
  };
}

function emptyUsageSummary(): UsageSummary {
  return {
    totalEvents: 0,
    perCommand: [],
    outcomes: [],
    duration: {
      averageMs: 0,
      p50Ms: 0,
      p95Ms: 0,
    },
    distinctWorkspaces: 0,
    versions: [],
    dateRange: null,
  };
}

function commandStats(events: readonly UsageEvent[]): readonly CommandStat[] {
  return countBy(events.map((event) => event.command)).map(({ value, count }) => ({
    command: value,
    count,
    share: count / events.length,
  }));
}

function outcomeStats(events: readonly UsageEvent[]): readonly OutcomeStat[] {
  return countBy(events.map((event) => event.outcome)).map(({ value, count }) => ({
    outcome: value,
    count,
  }));
}

function versionStats(events: readonly UsageEvent[]): readonly VersionStat[] {
  return countBy(events.map((event) => event.symnavVersion)).map(({ value, count }) => ({
    version: value,
    count,
  }));
}

function countBy<T extends string>(
  values: readonly T[],
): Array<{ readonly value: T; readonly count: number }> {
  const counts = new Map<T, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function percentile(sortedDurations: readonly number[], percentileRank: number): number {
  const rank = Math.ceil(percentileRank * sortedDurations.length);
  return sortedDurations[Math.max(rank - 1, 0)] ?? 0;
}
