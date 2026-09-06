import { mkdirSync } from "node:fs";
import { DaemonPolicy, type DaemonPolicyValues } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "./daemon-policy.js";
import {
  DaemonTransportFactory,
  type DaemonTransportComponents,
  type DaemonTransportOptions,
} from "../../src/transport/daemon-transport.js";
import type {
  DaemonExecuteRequest,
  DaemonExecutionStatusRequest,
  DaemonLifecycleRequest,
} from "../../src/transport/protocol.js";
import type { DaemonRequestHandler } from "../../src/transport/contracts.js";

type DaemonTransportPolicy = Pick<DaemonPolicyValues, "transport" | "delivery" | "output">;

interface TestDaemonTransportOptions {
  readonly maximumFrameBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly executionRequestTimeoutMs?: number;
  readonly writeChunkSize?: number;
  readonly outputDirectory?: string;
  readonly outputInlineBytes?: number;
}

export class TestDaemonTransport {
  private readonly components: DaemonTransportComponents;

  constructor(
    policyOrOptions:
      | DaemonPolicyValues
      | DaemonTransportPolicy
      | DaemonTransportOptions
      | TestDaemonTransportOptions = {},
  ) {
    if ("policy" in policyOrOptions) {
      this.components = DaemonTransportFactory.create(policyOrOptions);
      return;
    }
    if ("transport" in policyOrOptions) {
      const policy = DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
        transport: policyOrOptions.transport,
        delivery: policyOrOptions.delivery,
        output: policyOrOptions.output,
      });
      this.components = DaemonTransportFactory.create({ policy });
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
    this.components = DaemonTransportFactory.create({
      policy,
      ...(options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize }),
      ...(options.outputDirectory === undefined
        ? {}
        : { captureDirectory: options.outputDirectory }),
    });
  }

  request(endpoint: string, request: DaemonLifecycleRequest) {
    return this.components.lifecycle.request(endpoint, request);
  }

  executionStatus(endpoint: string, request: DaemonExecutionStatusRequest) {
    return this.components.lifecycle.executionStatus(endpoint, request);
  }

  execute(endpoint: string, request: DaemonExecuteRequest) {
    return this.components.execution.execute(endpoint, request);
  }

  listen(endpoint: string, handler: DaemonRequestHandler) {
    return this.components.server.listen(endpoint, handler);
  }

  removeUnavailableEndpoint(endpoint: string) {
    return this.components.server.removeUnavailableEndpoint(endpoint);
  }
}
