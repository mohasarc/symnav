import { readFileSync } from "node:fs";
import { SCHEMA_VERSION } from "./usage-event.js";
import type { ArgKind, LengthBucket, Outcome, UsageEvent } from "./usage-event.js";
import type { UsageLogReader } from "./usage-log-reader.js";

const outcomes = new Set<Outcome>(["success", "user_error", "crash"]);
const argKinds = new Set<ArgKind>(["symbol_id", "path", "bare", "empty"]);
const lengthBuckets = new Set<LengthBucket>(["empty", "short", "medium", "long"]);

export class NodeUsageLogReader implements UsageLogReader {
  read(usageFilePath: string): readonly UsageEvent[] {
    try {
      return readFileSync(usageFilePath, "utf8")
        .split("\n")
        .flatMap((line) => parseUsageEventLine(line));
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }
}

function parseUsageEventLine(line: string): readonly UsageEvent[] {
  if (line.trim() === "") {
    return [];
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    return isUsageEvent(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function isUsageEvent(value: unknown): value is UsageEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.symnavVersion !== "string" ||
    typeof value.command !== "string" ||
    typeof value.timestamp !== "number" ||
    typeof value.durationMs !== "number" ||
    typeof value.workspaceId !== "string" ||
    typeof value.machineId !== "string" ||
    typeof value.sessionId !== "string" ||
    !isArgShape(value.argShape) ||
    !outcomes.has(value.outcome as Outcome)
  ) {
    return false;
  }

  if (value.outcome === "success") {
    return true;
  }

  return typeof value.errorReason === "string";
}

function isArgShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    argKinds.has(value.kind as ArgKind) &&
    lengthBuckets.has(value.lengthBucket as LengthBucket) &&
    Array.isArray(value.flags) &&
    value.flags.every((flag) => typeof flag === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
