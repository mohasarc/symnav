import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export class StateDirectoryResolver {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory: string = homedir(),
  ) {}

  resolve(): string {
    const configuredDirectory =
      this.environment.SYMNAV_STATE_DIR ?? join(this.homeDirectory, ".symnav");
    return StateDirectoryResolver.canonicalize(configuredDirectory);
  }

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
