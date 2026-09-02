import { createDefaultDependencies } from "../program.js";
import { DaemonProcessConfigurationParser } from "./daemon-process-launcher.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";
import { WorkspaceDaemon } from "./workspace-daemon.js";

class DaemonEntry {
  static async run(encodedConfiguration: string | undefined): Promise<void> {
    const configuration = DaemonProcessConfigurationParser.parse(encodedConfiguration);
    const identity = DaemonWorkspaceIdentity.from(
      configuration.workspaceRoot,
      configuration.stateDir,
    );
    if (
      identity.workspaceKey !== configuration.workspaceKey ||
      identity.endpoint(configuration.instanceId) !== configuration.endpoint
    )
      throw new Error("Daemon process identity does not match configuration");
    const dependencies = createDefaultDependencies();
    if (dependencies.symnavVersion !== configuration.symnavVersion) {
      throw new Error("Daemon process version does not match launcher");
    }
    const registry = new DaemonRegistry(identity.registryDirectory);
    await new WorkspaceDaemon({
      identity,
      instanceId: configuration.instanceId,
      processToken: configuration.processToken,
      symnavVersion: configuration.symnavVersion,
      memoryCapBytes: configuration.memoryCapBytes,
      dependencies,
      registry,
      transport: new LocalDaemonTransport(),
    }).start();
  }
}

await DaemonEntry.run(process.argv[2]);
