import { describe, expect, it } from "vitest";
import type { IdGenerator } from "./id-generator.js";
import { NodeUsageRecorder, type UsageEventInput } from "./recorder.js";
import type { TelemetryWritePort } from "./write-port.js";

class CapturingWritePort implements TelemetryWritePort {
  readonly ensuredDirs: string[] = [];
  readonly appendedLines: Array<{ readonly filePath: string; readonly line: string }> = [];

  ensureDir(dir: string): void {
    this.ensuredDirs.push(dir);
  }

  appendLine(filePath: string, line: string): void {
    this.appendedLines.push({ filePath, line });
  }
}

class ThrowingWritePort implements TelemetryWritePort {
  constructor(private readonly fault: "ensureDir" | "appendLine") {}

  ensureDir(): void {
    if (this.fault === "ensureDir") {
      throw new Error("ensureDir failed");
    }
  }

  appendLine(): void {
    if (this.fault === "appendLine") {
      throw new Error("appendLine failed");
    }
  }
}

class FixedIdGenerator implements IdGenerator {
  next(): string {
    return "session-1";
  }
}

describe("NodeUsageRecorder", () => {
  it("builds a complete event from input", () => {
    const writePort = new CapturingWritePort();
    const recorder = new NodeUsageRecorder(writePort, new FixedIdGenerator(), "/state");
    const input = usageEventInput();

    recorder.record(input);

    expect(writePort.ensuredDirs).toEqual(["/state"]);
    const appendedLine = onlyAppendedLine(writePort);
    expect(appendedLine).toEqual({
      filePath: "/state/usage.jsonl",
      line: '{"schemaVersion":1,"symnavVersion":"0.1.0","command":"overview","timestamp":1790000000000,"durationMs":42,"outcome":"user_error","errorReason":"no-match","argShape":{"kind":"path","lengthBucket":"medium","flags":["json"]},"resultCounts":{"symbols":3},"workspaceId":"workspace","machineId":"machine","sessionId":"session-1"}',
    });
    expect(JSON.parse(appendedLine.line)).toEqual({
      schemaVersion: 1,
      ...input,
      sessionId: "session-1",
    });
  });

  it("omits absent optional fields", () => {
    const writePort = new CapturingWritePort();
    const recorder = new NodeUsageRecorder(writePort, new FixedIdGenerator(), "/state");
    const { errorReason, resultCounts, ...input } = usageEventInput();

    recorder.record(input);

    expect(onlyAppendedLine(writePort).line).toBe(
      '{"schemaVersion":1,"symnavVersion":"0.1.0","command":"overview","timestamp":1790000000000,"durationMs":42,"outcome":"user_error","argShape":{"kind":"path","lengthBucket":"medium","flags":["json"]},"workspaceId":"workspace","machineId":"machine","sessionId":"session-1"}',
    );
  });

  it.each(["ensureDir", "appendLine"] as const)("swallows %s faults", (fault) => {
    const recorder = new NodeUsageRecorder(
      new ThrowingWritePort(fault),
      new FixedIdGenerator(),
      "/state",
    );

    expect(() => recorder.record(usageEventInput())).not.toThrow();
  });
});

function usageEventInput(): UsageEventInput {
  return {
    symnavVersion: "0.1.0",
    command: "overview",
    timestamp: 1_790_000_000_000,
    durationMs: 42,
    outcome: "user_error",
    errorReason: "no-match",
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
  };
}

function onlyAppendedLine(writePort: CapturingWritePort): {
  readonly filePath: string;
  readonly line: string;
} {
  expect(writePort.appendedLines).toHaveLength(1);
  const appendedLine = writePort.appendedLines[0];
  if (appendedLine === undefined) {
    throw new Error("expected one appended line");
  }

  return appendedLine;
}
