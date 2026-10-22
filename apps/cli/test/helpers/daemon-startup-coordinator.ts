import { DaemonPolicy, type DaemonPolicyValues } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import type {
  DaemonProcessLauncher,
  DaemonProcessTerminator,
} from "../../src/daemon/daemon-process-launcher.js";
import type { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import { DaemonStartupCoordinator as RuntimeDaemonStartupCoordinator } from "../../src/daemon/daemon-startup-coordinator.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequestSender,
} from "../../src/daemon/daemon-transport.js";

interface TestDaemonStartupCoordinatorOptions {
  readonly policy?: Pick<DaemonPolicyValues, "startup" | "shutdown">;
  readonly terminationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly instanceId?: () => string;
  readonly processTerminator?: DaemonProcessTerminator;
}

export class TestDaemonStartupCoordinator extends RuntimeDaemonStartupCoordinator {
  constructor(
    registry: DaemonRegistry,
    launcher: DaemonProcessLauncher,
    transport: DaemonLifecycleRequestSender & DaemonExecutionRequester,
    options: TestDaemonStartupCoordinatorOptions = {},
  ) {
    const policy =
      options.policy ??
      DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
        startup: {
          ...(options.terminationTimeoutMs === undefined
            ? {}
            : { previousInstanceTerminationTimeoutMs: options.terminationTimeoutMs }),
          ...(options.pollIntervalMs === undefined
            ? {}
            : { observationPollIntervalMs: options.pollIntervalMs }),
        },
      }).values;
    super(registry, launcher, transport, {
      policy,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
      ...(options.processTerminator === undefined
        ? {}
        : { processTerminator: options.processTerminator }),
    });
  }
}
