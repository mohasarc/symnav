import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeUsageLogReader } from "./node-usage-log-reader.js";
import { SCHEMA_VERSION, type UsageEvent } from "./usage-event.js";

describe("NodeUsageLogReader", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
    roots.length = 0;
  });

  it("reads usage events and skips malformed lines", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-telemetry-"));
    roots.push(root);
    const usageFilePath = join(root, "usage.jsonl");
    const events = [usageEvent("overview", 1), usageEvent("def", 2)];
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
});

function usageEvent(command: string, timestamp: number): UsageEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    symnavVersion: "0.1.0",
    command,
    timestamp,
    durationMs: 42,
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
