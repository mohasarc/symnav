import { DaemonPolicy, type DaemonPolicyValues } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "./daemon-policy.js";
import { DaemonController as RuntimeDaemonController } from "../../src/process/controller.js";
import type {
  DaemonProcessLauncher,
  DaemonProcessTerminator,
} from "../../src/process/process-launcher.js";
import type { DaemonRegistry } from "../../src/registry/registry.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequestSender,
} from "../../src/transport/contracts.js";

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
    transport: DaemonLifecycleRequestSender & DaemonExecutionRequester,
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
      ...(options.now === undefined ? {} : { clock: { wallNowMs: options.now } }),
      ...(options.processTerminator === undefined
        ? {}
        : { processTerminator: options.processTerminator }),
      ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    });
  }
}
