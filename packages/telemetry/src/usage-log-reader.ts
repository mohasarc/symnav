import type { UsageEvent } from "./usage-event.js";

export interface UsageLogReader {
  read(usageFilePath: string): readonly UsageEvent[];
}
