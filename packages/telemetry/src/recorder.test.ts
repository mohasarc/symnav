import { describe, expect, it } from "vitest";
import type { IdGenerator } from "./id-generator.js";
import { NodeUsageRecorder, type UsageEventInput } from "./recorder.js";
import type { TelemetryWritePort } from "./write-port.js";

class CapturingWritePort implements TelemetryWritePort {
  readonly appendedLines: string[] = [];

  append(line: string): void {
    this.appendedLines.push(line);
  }
}

class ThrowingWritePort implements TelemetryWritePort {
  append(): void {
    throw new Error("append failed");
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
    const recorder = new NodeUsageRecorder(writePort, new FixedIdGenerator());
    const input = usageEventInput();

    recorder.record(input);

    const appendedLine = onlyAppendedLine(writePort);
    expect(appendedLine).toBe(
      '{"schemaVersion":1,"symnavVersion":"0.1.0","command":"overview","timestamp":1790000000000,"durationMs":42,"outcome":"user_error","errorReason":"no-match","argShape":{"kind":"path","lengthBucket":"medium","flags":["json"]},"resultCounts":{"symbols":3},"workspaceId":"workspace","machineId":"machine","sessionId":"session-1"}',
    );
    expect(JSON.parse(appendedLine)).toEqual({
      schemaVersion: 1,
      ...input,
      sessionId: "session-1",
    });
  });

  it("omits absent optional fields", () => {
    const writePort = new CapturingWritePort();
    const recorder = new NodeUsageRecorder(writePort, new FixedIdGenerator());
    const input: UsageEventInput = {
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
      workspaceId: "workspace",
      machineId: "machine",
    };

    recorder.record(input);

    expect(onlyAppendedLine(writePort)).toBe(
      '{"schemaVersion":1,"symnavVersion":"0.1.0","command":"overview","timestamp":1790000000000,"durationMs":42,"outcome":"success","argShape":{"kind":"path","lengthBucket":"medium","flags":["json"]},"workspaceId":"workspace","machineId":"machine","sessionId":"session-1"}',
    );
  });

  it("swallows write faults", () => {
    const recorder = new NodeUsageRecorder(new ThrowingWritePort(), new FixedIdGenerator());

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

function onlyAppendedLine(writePort: CapturingWritePort): string {
  expect(writePort.appendedLines).toHaveLength(1);
  const appendedLine = writePort.appendedLines[0];
  if (appendedLine === undefined) {
    throw new Error("expected one appended line");
  }

  return appendedLine;
}
