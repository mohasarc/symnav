import { DaemonPolicy } from "@symnav/daemon";
import { NodeDaemonClock } from "./daemon-clock.js";
import { DaemonLogger } from "./daemon-logger.js";
import { DaemonProcessConfigurationParser } from "./daemon-process-launcher.js";
import { DaemonProcessTerminationObserver } from "./daemon-process-termination-observer.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";
import { DaemonProcessCoordinator } from "./daemon-process-coordinator.js";

class DaemonEntry {
  static async run(encodedConfiguration: string | undefined): Promise<void> {
    const configuration = DaemonProcessConfigurationParser.parse(encodedConfiguration);
    const identity = DaemonWorkspaceIdentity.from(
      configuration.workspaceRoot,
      configuration.stateDirectory,
    );
    const policy = DaemonPolicy.fromSerialized(configuration.policy);
    const clock = new NodeDaemonClock();
    const registry = new DaemonRegistry(identity.registryDirectory, policy.values.startup, clock);
    const logger = new DaemonLogger(identity, configuration.instanceId, clock, {
      policy: policy.values.diagnostics,
    });
    const coordinator = new DaemonProcessCoordinator({
      identity,
      coordinates: configuration,
      productVersion: configuration.symnavVersion,
      executorModuleUrl: configuration.executorModuleUrl,
      policy,
      registry,
      server: new LocalDaemonTransport({ policy }),
      clock,
      logger,
    });
    new DaemonProcessTerminationObserver(logger, () => {
      registry.removeIfProcess(identity, configuration.instanceId, configuration.processToken);
    }).install();
    await coordinator.start();
  }
}

await DaemonEntry.run(process.argv[2]);
