import { readdirSync } from "node:fs";
import { join } from "node:path";

export class DaemonStateFiles {
  static matchingPaths(stateDirectory: string, suffix: string): readonly string[] {
    const registryDirectory = join(stateDirectory, "daemons");
    try {
      return readdirSync(registryDirectory, { withFileTypes: true }).flatMap((identityEntry) => {
        if (!identityEntry.isDirectory()) return [];
        const identityDirectory = join(registryDirectory, identityEntry.name);
        return readdirSync(identityDirectory, { withFileTypes: true }).flatMap((entry) =>
          entry.isFile() && entry.name.endsWith(suffix)
            ? [join(identityDirectory, entry.name)]
            : [],
        );
      });
    } catch {
      return [];
    }
  }
}
