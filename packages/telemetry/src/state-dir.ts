import { join } from "node:path";

export function usageLogPath(stateDir: string): string {
  return join(stateDir, "usage.jsonl");
}
