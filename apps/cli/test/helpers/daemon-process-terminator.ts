import { DaemonPolicy, type DaemonPolicyValues } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { NodeDaemonProcessTerminator as RuntimeNodeDaemonProcessTerminator } from "../../src/daemon/daemon-process-launcher.js";

export class TestNodeDaemonProcessTerminator extends RuntimeNodeDaemonProcessTerminator {
  constructor(
    policyOrSignalExitTimeoutMs:
      | DaemonPolicyValues["shutdown"]
      | number = DaemonPolicy.currentSystem().values.shutdown,
    processExitPollIntervalMs?: number,
  ) {
    if (typeof policyOrSignalExitTimeoutMs !== "number") {
      super(policyOrSignalExitTimeoutMs);
      return;
    }
    const policy = DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
      shutdown: {
        processSignalExitTimeoutMs: policyOrSignalExitTimeoutMs,
        ...(processExitPollIntervalMs === undefined ? {} : { processExitPollIntervalMs }),
      },
    });
    super(policy.values.shutdown);
  }
}
