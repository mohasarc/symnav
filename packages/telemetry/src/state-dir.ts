import { existsSync, realpathSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

class StateDirectoryPath {
  static canonicalize(stateDirectory: string): string {
    const absoluteDirectory = resolve(stateDirectory);
    const missingSegments: string[] = [];
    let existingAncestor = absoluteDirectory;
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return absoluteDirectory;
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
    return join(realpathSync(existingAncestor), ...missingSegments);
  }
}

export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir = osHomedir(),
): string {
  const configuredDirectory = env.SYMNAV_STATE_DIR ?? join(homedir, ".symnav");
  return StateDirectoryPath.canonicalize(configuredDirectory);
}

export function usageLogPath(stateDir: string): string {
  return join(stateDir, "usage.jsonl");
}
