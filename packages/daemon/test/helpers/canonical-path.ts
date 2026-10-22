import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class CanonicalTestPath {
  static resolve(path: string): string {
    const absolutePath = resolve(path);
    const missingSegments: string[] = [];
    let existingAncestor = absolutePath;
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return absolutePath;
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
    return join(realpathSync(existingAncestor), ...missingSegments);
  }
}
