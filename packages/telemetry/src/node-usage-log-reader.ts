import { readFileSync } from "node:fs";
import type { UsageEvent } from "./usage-event.js";
import type { UsageLogReader } from "./usage-log-reader.js";

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
    return [JSON.parse(line) as UsageEvent];
  } catch {
    return [];
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
