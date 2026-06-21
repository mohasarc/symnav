import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type UsageEvent } from "./usage-event.js";

describe("usage event schema", () => {
  it("exports a positive integer schema version", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("accepts the expected usage event keys", () => {
    const event: UsageEvent = {
      schemaVersion: SCHEMA_VERSION,
      symnavVersion: "0.1.0",
      command: "overview",
      timestamp: 1_790_000_000_000,
      durationMs: 42,
      outcome: "success",
      argShape: {
        kind: "path",
        lengthBucket: "medium",
        flags: ["json"],
      },
      resultCounts: {
        symbols: 3,
      },
      workspaceId: "workspace",
      machineId: "machine",
      sessionId: "session",
    };

    expect(Object.keys(event).sort()).toEqual([
      "argShape",
      "command",
      "durationMs",
      "machineId",
      "outcome",
      "resultCounts",
      "schemaVersion",
      "sessionId",
      "symnavVersion",
      "timestamp",
      "workspaceId",
    ]);
  });
});
