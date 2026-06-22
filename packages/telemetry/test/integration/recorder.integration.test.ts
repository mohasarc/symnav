import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IdGenerator } from "../../src/id-generator.js";
import { NodeUsageRecorder, type UsageEventInput } from "../../src/recorder.js";
import { NodeTelemetryWritePort } from "../../src/write-port.js";

class FixedIdGenerator implements IdGenerator {
  next(): string {
    return "session-1";
  }
}

describe("NodeUsageRecorder integration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
    roots.length = 0;
  });

  it("appends events to usage.jsonl and creates the state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-telemetry-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const usageLog = join(stateDir, "usage.jsonl");
    const recorder = new NodeUsageRecorder(
      new NodeTelemetryWritePort(usageLog),
      new FixedIdGenerator(),
    );

    recorder.record(usageEventInput("overview", 1));
    recorder.record(usageEventInput("def", 2));

    expect(existsSync(stateDir)).toBe(true);
    const lines = readFileSync(usageLog, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        schemaVersion: 1,
        ...usageEventInput("overview", 1),
        sessionId: "session-1",
      },
      {
        schemaVersion: 1,
        ...usageEventInput("def", 2),
        sessionId: "session-1",
      },
    ]);
  });
});

function usageEventInput(command: string, timestamp: number): UsageEventInput {
  return {
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
  };
}
