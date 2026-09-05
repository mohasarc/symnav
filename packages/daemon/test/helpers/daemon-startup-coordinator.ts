import { DaemonPolicy, type DaemonPolicyValues, type DaemonReadinessProbe } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "./daemon-policy.js";
import type {
  DaemonProcessLauncher,
  DaemonProcessTerminator,
} from "../../src/process/process-launcher.js";
import type { DaemonRegistry } from "../../src/registry/registry.js";
import { DaemonStartupCoordinator as RuntimeDaemonStartupCoordinator } from "../../src/registry/startup-coordinator.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequestSender,
} from "../../src/transport/contracts.js";

interface TestDaemonStartupCoordinatorOptions {
  readonly policy?: Pick<DaemonPolicyValues, "startup" | "shutdown">;
  readonly terminationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly instanceId?: () => string;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly readinessProbe?: DaemonReadinessProbe;
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
      ...(options.now === undefined ? {} : { clock: { wallNowMs: options.now } }),
      ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
      ...(options.processTerminator === undefined
        ? {}
        : { processTerminator: options.processTerminator }),
      ...(options.readinessProbe === undefined ? {} : { readinessProbe: options.readinessProbe }),
    });
  }
}
