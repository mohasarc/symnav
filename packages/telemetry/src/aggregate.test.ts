import { describe, expect, it } from "vitest";
import { aggregate } from "./aggregate.js";
import { SCHEMA_VERSION, type Outcome, type UsageEvent } from "./usage-event.js";

describe("aggregate", () => {
  it("summarizes usage events", () => {
    const summary = aggregate([
      usageEvent({
        command: "overview",
        durationMs: 10,
        outcome: "success",
        symnavVersion: "0.2.0",
        timestamp: 500,
        workspaceId: "workspace-a",
      }),
      usageEvent({
        command: "def",
        durationMs: 20,
        outcome: "user_error",
        symnavVersion: "0.1.0",
        timestamp: 100,
        workspaceId: "workspace-b",
      }),
      usageEvent({
        command: "overview",
        durationMs: 30,
        outcome: "success",
        symnavVersion: "0.2.0",
        timestamp: 300,
        workspaceId: "workspace-a",
      }),
      usageEvent({
        command: "refs",
        durationMs: 40,
        outcome: "crash",
        symnavVersion: "0.1.0",
        timestamp: 900,
        workspaceId: "workspace-c",
      }),
      usageEvent({
        command: "def",
        durationMs: 100,
        outcome: "user_error",
        symnavVersion: "0.2.0",
        timestamp: 700,
        workspaceId: "workspace-b",
      }),
      usageEvent({
        command: "overview",
        durationMs: 200,
        outcome: "success",
        symnavVersion: "0.3.0",
        timestamp: 200,
        workspaceId: "workspace-c",
      }),
    ]);

    expect(summary.totalEvents).toBe(6);
    expect(summary.perCommand).toEqual([
      { command: "overview", count: 3, share: 0.5 },
      { command: "def", count: 2, share: 2 / 6 },
      { command: "refs", count: 1, share: 1 / 6 },
    ]);
    expect(summary.perCommand.reduce((sum, stat) => sum + stat.share, 0)).toBeCloseTo(1);
    expect(summary.outcomes).toEqual([
      { outcome: "success", count: 3 },
      { outcome: "user_error", count: 2 },
      { outcome: "crash", count: 1 },
    ]);
    expect(summary.duration).toEqual({
      averageMs: 400 / 6,
      p50Ms: 30,
      p95Ms: 200,
    });
    expect(summary.distinctWorkspaces).toBe(3);
    expect(summary.versions).toEqual([
      { version: "0.2.0", count: 3 },
      { version: "0.1.0", count: 2 },
      { version: "0.3.0", count: 1 },
    ]);
    expect(summary.dateRange).toEqual({ earliest: 100, latest: 900 });
  });

  it("returns an empty summary for no events", () => {
    expect(aggregate([])).toEqual({
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
    });
  });
});

function usageEvent(overrides: UsageEventOverrides): UsageEvent {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    symnavVersion: overrides.symnavVersion,
    command: overrides.command,
    timestamp: overrides.timestamp,
    durationMs: overrides.durationMs,
    argShape: {
      kind: "path",
      lengthBucket: "medium",
      flags: [],
    },
    workspaceId: overrides.workspaceId,
    machineId: "machine",
    sessionId: "session",
  } satisfies Partial<UsageEvent>;

  if (overrides.outcome === "success") {
    return { ...base, outcome: "success" };
  }

  return { ...base, outcome: overrides.outcome, errorReason: "reason" };
}

interface UsageEventOverrides {
  readonly command: string;
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly symnavVersion: string;
  readonly timestamp: number;
  readonly workspaceId: string;
}
