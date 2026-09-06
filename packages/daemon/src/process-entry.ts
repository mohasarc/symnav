import { DaemonPolicyCodec } from "./daemon-policy.js";
import { NodeDaemonClock } from "./lifecycle/daemon-clock.js";
import { DaemonLogger } from "./diagnostics/logger.js";
import { DaemonProcessConfigurationParser } from "./process/process-launcher.js";
import { DaemonProcessTerminationObserver } from "./process/process-termination-observer.js";
import { DaemonProcessCoordinator } from "./process/process-coordinator.js";
import { DaemonRegistry } from "./registry/registry.js";
import { DaemonWorkspaceIdentity } from "./registry/workspace-identity.js";
import { DaemonTransportFactory } from "./transport/daemon-transport.js";

class DaemonProcessEntry {
  static async run(encodedConfiguration: string | undefined): Promise<void> {
    const configuration = DaemonProcessConfigurationParser.parse(encodedConfiguration);
    const identity = DaemonWorkspaceIdentity.from(
      configuration.workspaceRoot,
      configuration.stateDirectory,
    );
    const policy = DaemonPolicyCodec.deserialize(configuration.policy);
    const clock = new NodeDaemonClock();
    const registry = new DaemonRegistry(identity.registryDirectory, policy.values.startup, clock);
    const logger = new DaemonLogger(identity, configuration.instanceId, clock, {
      policy: policy.values.diagnostics,
    });
    const server = DaemonTransportFactory.create({ policy }).server;
    const coordinator = new DaemonProcessCoordinator({
      identity,
      coordinates: configuration,
      productVersion: configuration.symnavVersion,
      executorModuleUrl: configuration.executorModuleUrl,
      policy,
      registry,
      server,
      clock,
      logger,
    });
    new DaemonProcessTerminationObserver(logger, () => {
      registry.removeIfProcess(identity, configuration.instanceId, configuration.processToken);
    }).install();
    await coordinator.start();
  }
}

await DaemonProcessEntry.run(process.argv[2]);
