import { posix } from "node:path";
import type { FileSystem } from "../file-system.js";

export function findWorkspaceRoot(startDir: string, fs: FileSystem): string | null {
  let current = startDir;
  while (true) {
    const gitPath = posix.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = posix.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
