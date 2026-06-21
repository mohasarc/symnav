import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export function resolveStateDir(env: NodeJS.ProcessEnv, homedir = osHomedir()): string {
  if (env.SYMNAV_STATE_DIR !== undefined) {
    return env.SYMNAV_STATE_DIR;
  }

  return join(homedir, ".symnav");
}

export function usageLogPath(stateDir: string): string {
  return join(stateDir, "usage.jsonl");
}
