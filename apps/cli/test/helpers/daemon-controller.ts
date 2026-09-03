import { DaemonPolicy, type DaemonPolicyValues } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { DaemonController as RuntimeDaemonController } from "../../src/daemon/daemon-controller.js";
import type {
  DaemonProcessLauncher,
  DaemonProcessTerminator,
} from "../../src/daemon/daemon-process-launcher.js";
import type { DaemonRegistry } from "../../src/daemon/daemon-registry.js";
import type { LocalDaemonTransport } from "../../src/daemon/local-daemon-transport.js";

interface TestDaemonControllerOptions {
  readonly policy?: Pick<DaemonPolicyValues, "startup" | "shutdown">;
  readonly now?: () => number;
  readonly stopTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly launcher?: DaemonProcessLauncher;
}

export class TestDaemonController extends RuntimeDaemonController {
  constructor(
    registry: DaemonRegistry,
    transport: LocalDaemonTransport,
    stateDirectory: string,
    options: TestDaemonControllerOptions = {},
  ) {
    const policy =
      options.policy ??
      DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
        shutdown: {
          ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
          ...(options.pollIntervalMs === undefined
            ? {}
            : { controllerPollIntervalMs: options.pollIntervalMs }),
        },
      }).values;
    super(registry, transport, stateDirectory, {
      policy,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.processTerminator === undefined
        ? {}
        : { processTerminator: options.processTerminator }),
      ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    });
  }
}
