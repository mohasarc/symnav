import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeUsageLogReader } from "./node-usage-log-reader.js";
import { SCHEMA_VERSION, type ExecutionMode, type UsageEvent } from "./usage-event.js";

type LegacyUsageEvent = Omit<UsageEvent, "executionMode">;

describe("NodeUsageLogReader", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
    roots.length = 0;
  });

  it("reads usage events and skips malformed lines", () => {
    const usageFilePath = usageLog(roots);
    const events = [usageEvent("overview", 1, "cold"), usageEvent("def", 2, "warm")];
    writeFileSync(
      usageFilePath,
      `${JSON.stringify(events[0])}\nnot json\n{}\n${JSON.stringify({ ...events[1], durationMs: undefined })}\n${JSON.stringify(events[1])}\n`,
      "utf8",
    );

    expect(new NodeUsageLogReader().read(usageFilePath)).toEqual(events);
  });

  it("returns an empty array when the usage log is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-telemetry-"));
    roots.push(root);

    expect(new NodeUsageLogReader().read(join(root, "missing.jsonl"))).toEqual([]);
  });

  it("normalizes schema-v1 events to cold execution", () => {
    const usageFilePath = usageLog(roots);
    const { executionMode: _executionMode, ...legacyEvent } = usageEvent("overview", 1, "warm");
    const schemaV1 = { ...legacyEvent, schemaVersion: 1 } satisfies LegacyUsageEvent;
    writeFileSync(usageFilePath, `${JSON.stringify(schemaV1)}\n`, "utf8");

    expect(new NodeUsageLogReader().read(usageFilePath)).toEqual([
      { ...schemaV1, executionMode: "cold" },
    ]);
  });

  it.each(["warm", "cold", "fallback"] as const)(
    "accepts schema-v2 %s execution",
    (executionMode) => {
      const usageFilePath = usageLog(roots);
      const event = usageEvent("overview", 1, executionMode);
      writeFileSync(usageFilePath, `${JSON.stringify(event)}\n`, "utf8");

      expect(new NodeUsageLogReader().read(usageFilePath)).toEqual([event]);
    },
  );

  it.each([undefined, "", "daemon", 1])("rejects schema-v2 execution mode %j", (executionMode) => {
    const usageFilePath = usageLog(roots);
    const event: Record<string, unknown> = {
      ...usageEvent("overview", 1, "cold"),
      executionMode,
    };
    writeFileSync(usageFilePath, `${JSON.stringify(event)}\n`, "utf8");

    expect(new NodeUsageLogReader().read(usageFilePath)).toEqual([]);
  });
});

function usageLog(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-telemetry-"));
  roots.push(root);
  return join(root, "usage.jsonl");
}

function usageEvent(command: string, timestamp: number, executionMode: ExecutionMode): UsageEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    symnavVersion: "0.1.0",
    command,
    timestamp,
    durationMs: 42,
    executionMode,
    outcome: "success",
    argShape: {
      kind: "path",
      lengthBucket: "medium",
      flags: [],
    },
    workspaceId: "workspace",
    machineId: "machine",
    sessionId: "session",
  };
}
