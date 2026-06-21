import type { UsageSummary } from "@symnav/telemetry";

export function renderStatsText(summary: UsageSummary): string {
  if (summary.totalEvents === 0) {
    return "No usage events recorded.\n";
  }

  return `${[
    "Usage summary",
    `Total events: ${summary.totalEvents}`,
    "",
    "Commands",
    ...summary.perCommand.map(
      (stat) =>
        `${stat.command.padEnd(commandColumnWidth(summary))}  ${String(stat.count).padStart(1)}  ${formatShare(stat.share)}`,
    ),
    "",
    "Outcomes",
    ...summary.outcomes.map(
      (stat) =>
        `${stat.outcome.padEnd(outcomeColumnWidth(summary))}  ${String(stat.count).padStart(1)}`,
    ),
    "",
    "Duration",
    `Average: ${formatMilliseconds(summary.duration.averageMs)}`,
    `P50: ${formatMilliseconds(summary.duration.p50Ms)}`,
    `P95: ${formatMilliseconds(summary.duration.p95Ms)}`,
    "",
    `Distinct workspaces: ${summary.distinctWorkspaces}`,
    "",
    "Versions",
    ...summary.versions.map(
      (stat) =>
        `${stat.version.padEnd(versionColumnWidth(summary))}  ${String(stat.count).padStart(1)}`,
    ),
    "",
    `Date range: ${formatDateRange(summary)}`,
  ].join("\n")}\n`;
}

export function renderStatsJson(summary: UsageSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

function commandColumnWidth(summary: UsageSummary): number {
  return Math.max(...summary.perCommand.map((stat) => stat.command.length));
}

function outcomeColumnWidth(summary: UsageSummary): number {
  return Math.max(...summary.outcomes.map((stat) => stat.outcome.length));
}

function versionColumnWidth(summary: UsageSummary): number {
  return Math.max(...summary.versions.map((stat) => stat.version.length));
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function formatMilliseconds(milliseconds: number): string {
  return `${milliseconds.toFixed(1)}ms`;
}

function formatDateRange(summary: UsageSummary): string {
  if (summary.dateRange === null) {
    return "(none)";
  }

  return `${new Date(summary.dateRange.earliest).toISOString()} to ${new Date(
    summary.dateRange.latest,
  ).toISOString()}`;
}
