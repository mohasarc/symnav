import type { UsageEvent } from "./usage-event.js";
import type { CommandStat, OutcomeStat, UsageSummary, VersionStat } from "./usage-summary.js";

export function aggregate(events: readonly UsageEvent[]): UsageSummary {
  return new UsageAggregator(events).aggregate();
}

class UsageAggregator {
  public constructor(private readonly events: readonly UsageEvent[]) {}

  public aggregate(): UsageSummary {
    if (this.events.length === 0) {
      return this.emptySummary();
    }

    const durations = this.sortedDurations();
    const timestamps = this.events.map((event) => event.timestamp);

    return {
      totalEvents: this.events.length,
      perCommand: this.commandStats(),
      outcomes: this.outcomeStats(),
      duration: {
        averageMs: durations.reduce((sum, durationMs) => sum + durationMs, 0) / durations.length,
        p50Ms: this.percentile(durations, 0.5),
        p95Ms: this.percentile(durations, 0.95),
      },
      distinctWorkspaces: new Set(this.events.map((event) => event.workspaceId)).size,
      versions: this.versionStats(),
      dateRange: {
        earliest: Math.min(...timestamps),
        latest: Math.max(...timestamps),
      },
    };
  }

  private emptySummary(): UsageSummary {
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

  private sortedDurations(): readonly number[] {
    return this.events.map((event) => event.durationMs).sort((left, right) => left - right);
  }

  private commandStats(): readonly CommandStat[] {
    return this.countBy(this.events.map((event) => event.command)).map(({ value, count }) => ({
      command: value,
      count,
      share: count / this.events.length,
    }));
  }

  private outcomeStats(): readonly OutcomeStat[] {
    return this.countBy(this.events.map((event) => event.outcome)).map(({ value, count }) => ({
      outcome: value,
      count,
    }));
  }

  private versionStats(): readonly VersionStat[] {
    return this.countBy(this.events.map((event) => event.symnavVersion)).map(
      ({ value, count }) => ({
        version: value,
        count,
      }),
    );
  }

  private countBy<T extends string>(
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

  private percentile(sortedDurations: readonly number[], percentileRank: number): number {
    const rank = Math.ceil(percentileRank * sortedDurations.length);
    return sortedDurations[Math.max(rank - 1, 0)] ?? 0;
  }
}
