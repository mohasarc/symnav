import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface UsageEvent {
  readonly command: string;
  readonly executionMode: string;
  readonly symnavVersion: string;
}

export class UsageLog {
  constructor(private readonly stateDirectory: string) {}

  events(): readonly UsageEvent[] {
    const lines = readFileSync(join(this.stateDirectory, "usage.jsonl"), "utf8").trim().split("\n");
    return lines.map((line) => JSON.parse(line) as UsageEvent);
  }
}
