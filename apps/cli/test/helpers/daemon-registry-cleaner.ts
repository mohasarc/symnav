import { existsSync, writeFileSync } from "node:fs";
import { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import { DaemonWorkspaceIdentity } from "../../src/daemon/daemon-workspace-identity.js";

class DaemonRegistryCleaner {
  static async run(args: readonly string[]): Promise<void> {
    const [workspaceRoot, stateDirectory, instanceId, readyPath, barrierPath] = args;
    if (
      workspaceRoot === undefined ||
      stateDirectory === undefined ||
      instanceId === undefined ||
      readyPath === undefined ||
      barrierPath === undefined
    ) {
      throw new Error("Missing daemon registry cleaner argument");
    }
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    writeFileSync(readyPath, "ready");
    while (!existsSync(barrierPath)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    registry.removeStartupLockIfInstance(identity, instanceId);
  }
}

await DaemonRegistryCleaner.run(process.argv.slice(2));
