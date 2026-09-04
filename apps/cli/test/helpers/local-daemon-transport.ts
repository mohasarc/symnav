import { mkdirSync } from "node:fs";
import { DaemonPolicy, type DaemonPolicyValues } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import {
  LocalDaemonTransport as RuntimeLocalDaemonTransport,
  type LocalDaemonTransportPolicy,
} from "../../src/daemon/local-daemon-transport.js";

interface TestLocalDaemonTransportOptions {
  readonly maximumFrameBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly executionRequestTimeoutMs?: number;
  readonly writeChunkSize?: number;
  readonly outputDirectory?: string;
  readonly outputInlineBytes?: number;
}

export class TestLocalDaemonTransport extends RuntimeLocalDaemonTransport {
  constructor(
    policyOrOptions:
      | DaemonPolicyValues
      | LocalDaemonTransportPolicy
      | TestLocalDaemonTransportOptions = {},
  ) {
    if ("transport" in policyOrOptions) {
      super(policyOrOptions);
      return;
    }
    const options = policyOrOptions;
    const base = DaemonPolicy.currentSystem();
    const policy = DaemonPolicyTestFactory.withOverrides(base, {
      transport: {
        ...(options.maximumFrameBytes === undefined
          ? {}
          : { maximumJsonPayloadBytes: options.maximumFrameBytes }),
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { singleResponseTimeoutMs: options.requestTimeoutMs }),
        ...(options.executionRequestTimeoutMs === undefined
          ? {}
          : { executionAdmissionTimeoutMs: options.executionRequestTimeoutMs }),
      },
      output: {
        ...(options.outputInlineBytes === undefined
          ? {}
          : {
              inlineRawBytes: Math.max(
                base.values.output.maximumChunkRawBytes,
                options.outputInlineBytes,
              ),
            }),
      },
    });
    if (options.outputDirectory !== undefined) {
      mkdirSync(options.outputDirectory, { recursive: true });
    }
    super(policy.values, {
      ...(options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize }),
      ...(options.outputDirectory === undefined
        ? {}
        : { outputDirectory: options.outputDirectory }),
    });
  }
}
