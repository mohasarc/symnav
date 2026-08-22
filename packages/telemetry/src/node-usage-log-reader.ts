import { readFileSync } from "node:fs";
import { SCHEMA_VERSION } from "./usage-event.js";
import type {
  ArgKind,
  ArgShape,
  ExecutionMode,
  LengthBucket,
  Outcome,
  UsageEvent,
  UsageEventContent,
} from "./usage-event.js";
import type { UsageLogReader } from "./usage-log-reader.js";

const outcomes = new Set<Outcome>(["success", "user_error", "crash"]);
const argKinds = new Set<ArgKind>(["symbol_id", "path", "bare", "empty"]);
const lengthBuckets = new Set<LengthBucket>(["empty", "short", "medium", "long"]);
const executionModes = new Set<ExecutionMode>(["warm", "cold", "fallback"]);

export class NodeUsageLogReader implements UsageLogReader {
  read(usageFilePath: string): readonly UsageEvent[] {
    try {
      return readFileSync(usageFilePath, "utf8")
        .split("\n")
        .flatMap((line) => NodeUsageLogReader.parseLine(line));
    } catch (error) {
      if (NodeUsageLogReader.isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }

  private static parseLine(line: string): readonly UsageEvent[] {
    if (line.trim() === "") {
      return [];
    }

    try {
      const event = NodeUsageLogReader.parseEvent(JSON.parse(line) as unknown);
      return event === undefined ? [] : [event];
    } catch {
      return [];
    }
  }

  private static parseEvent(value: unknown): UsageEvent | undefined {
    if (!NodeUsageLogReader.hasSharedFields(value)) {
      return undefined;
    }
    if (value.schemaVersion === 1) {
      return NodeUsageLogReader.toUsageEvent(value, "cold");
    }
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      !executionModes.has(value.executionMode as ExecutionMode)
    ) {
      return undefined;
    }
    return NodeUsageLogReader.toUsageEvent(value, value.executionMode as ExecutionMode);
  }

  private static toUsageEvent(
    value: Record<string, unknown>,
    executionMode: ExecutionMode,
  ): UsageEvent {
    const shared: UsageEventContent & {
      readonly schemaVersion: number;
      readonly sessionId: string;
    } = {
      schemaVersion: value.schemaVersion as number,
      symnavVersion: value.symnavVersion as string,
      command: value.command as string,
      timestamp: value.timestamp as number,
      durationMs: value.durationMs as number,
      executionMode,
      argShape: value.argShape as ArgShape,
      ...(NodeUsageLogReader.isResultCounts(value.resultCounts)
        ? { resultCounts: value.resultCounts }
        : {}),
      workspaceId: value.workspaceId as string,
      machineId: value.machineId as string,
      sessionId: value.sessionId as string,
    };
    if (value.outcome === "success") {
      return { ...shared, outcome: "success" };
    }
    return {
      ...shared,
      outcome: value.outcome as "user_error" | "crash",
      errorReason: value.errorReason as string,
    };
  }

  private static hasSharedFields(value: unknown): value is Record<string, unknown> {
    if (!NodeUsageLogReader.isRecord(value)) {
      return false;
    }
    if (
      typeof value.symnavVersion !== "string" ||
      typeof value.command !== "string" ||
      typeof value.timestamp !== "number" ||
      typeof value.durationMs !== "number" ||
      typeof value.workspaceId !== "string" ||
      typeof value.machineId !== "string" ||
      typeof value.sessionId !== "string" ||
      !NodeUsageLogReader.isArgShape(value.argShape) ||
      !outcomes.has(value.outcome as Outcome)
    ) {
      return false;
    }
    return value.outcome === "success" || typeof value.errorReason === "string";
  }

  private static isArgShape(value: unknown): boolean {
    return (
      NodeUsageLogReader.isRecord(value) &&
      argKinds.has(value.kind as ArgKind) &&
      lengthBuckets.has(value.lengthBucket as LengthBucket) &&
      Array.isArray(value.flags) &&
      value.flags.every((flag) => typeof flag === "string")
    );
  }

  private static isResultCounts(value: unknown): value is Readonly<Record<string, number>> {
    return (
      NodeUsageLogReader.isRecord(value) &&
      Object.values(value).every((count) => typeof count === "number")
    );
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private static isMissingFile(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}
