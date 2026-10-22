import { createDefaultDependencies } from "../program.js";
import { DaemonPolicy } from "@symnav/daemon";
import { NodeDaemonClock } from "./daemon-clock.js";
import { DaemonLogger } from "./daemon-logger.js";
import { DaemonProcessConfigurationParser } from "./daemon-process-launcher.js";
import { DaemonProcessTerminationObserver } from "./daemon-process-termination-observer.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";
import { WorkspaceDaemon } from "./workspace-daemon.js";

class DaemonEntry {
  static async run(encodedConfiguration: string | undefined): Promise<void> {
    const configuration = DaemonProcessConfigurationParser.parse(encodedConfiguration);
    const identity = DaemonWorkspaceIdentity.from(
      configuration.workspaceRoot,
      configuration.stateDirectory,
    );
    if (
      identity.workspaceKey !== configuration.workspaceKey ||
      identity.stateKey !== configuration.stateKey ||
      identity.identityKey !== configuration.identityKey ||
      identity.endpoint(configuration.instanceId) !== configuration.endpoint
    )
      throw new Error("Daemon process identity does not match configuration");
    const policy = DaemonPolicy.fromSerialized(configuration.policy);
    const dependencies = createDefaultDependencies(configuration.stateDirectory, policy);
    if (dependencies.symnavVersion !== configuration.symnavVersion) {
      throw new Error("Daemon process version does not match launcher");
    }
    const registry = new DaemonRegistry(identity.registryDirectory, policy.values.startup);
    const clock = new NodeDaemonClock();
    const logger = new DaemonLogger(identity, configuration.instanceId, clock, {
      policy: policy.values.diagnostics,
    });
    new DaemonProcessTerminationObserver(logger, () => {
      registry.removeIfProcess(identity, configuration.instanceId, configuration.processToken);
    }).install();
    await new WorkspaceDaemon({
      identity,
      instanceId: configuration.instanceId,
      processToken: configuration.processToken,
      symnavVersion: configuration.symnavVersion,
      policy,
      dependencies,
      registry,
      transport: new LocalDaemonTransport(policy.values),
      clock,
      logger,
    }).start();
  }
}

await DaemonEntry.run(process.argv[2]);
