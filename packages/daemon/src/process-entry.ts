import { PosixDaemonProcessLifetime } from "./process/posix-process-lifetime.js";
import { DaemonFailureRecorder } from "./diagnostics/failure-recorder.js";
import { DaemonFailureJournal } from "./diagnostics/failure-journal.js";
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
    if (configuration.processLifetime !== undefined)
      PosixDaemonProcessLifetime.adoptChild(
        configuration.stateDirectory,
        configuration.processLifetime,
        3,
      );
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
    const server = DaemonTransportFactory.create({
      policy,
      captureDirectory: identity.spoolDirectory,
    }).server;
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
    const failureJournal = new DaemonFailureJournal(
      identity.stateDirectory,
      policy.values.diagnostics,
      clock,
    );
    new DaemonProcessTerminationObserver(
      logger,
      () => {
        registry.removeIfProcess(identity, configuration.instanceId, configuration.processToken);
      },
      undefined,
      async (failure) => {
        const record = registry.recordForProcess(
          identity,
          configuration.instanceId,
          configuration.processToken,
        );
        await new DaemonFailureRecorder(failureJournal, identity.workspaceRoot, clock).record(
          record?.state === "starting" ? "startup-failure" : "termination",
          failure.phase,
          failure.reason,
          failure.osCode === undefined ? undefined : { code: failure.osCode },
          configuration.instanceId,
        );
      },
      clock,
    ).install();
    await coordinator.start();
  }
}

await DaemonProcessEntry.run(process.argv[2]);
