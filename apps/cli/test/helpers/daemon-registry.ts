import { renameSync } from "node:fs";
import { DaemonPolicy, type DaemonPolicyValues } from "@symnav/daemon";
import { DaemonRegistry as RuntimeDaemonRegistry } from "../../src/daemon/daemon-registry.js";

export class TestDaemonRegistry extends RuntimeDaemonRegistry {
  constructor(
    registryDirectory: string,
    platformOrPolicy: NodeJS.Platform | DaemonPolicyValues["startup"] = process.platform,
    renamePath: typeof renameSync = renameSync,
  ) {
    if (typeof platformOrPolicy === "string") {
      super(
        registryDirectory,
        DaemonPolicy.currentSystem().values.startup,
        platformOrPolicy,
        renamePath,
      );
      return;
    }
    super(registryDirectory, platformOrPolicy, process.platform, renamePath);
  }
}
