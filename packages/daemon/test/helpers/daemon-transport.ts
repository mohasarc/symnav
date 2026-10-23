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

import { LocalDaemonSocketClient } from "../../src/transport/socket-client.js";
import { LocalDaemonSocketServer } from "../../src/transport/socket-server.js";
import { DaemonWireCodec } from "../../src/transport/wire-codec.js";
import { DaemonProtocolValidator } from "../../src/transport/protocol-validator.js";

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
  private readonly injectedSockets:
    | import("../../src/transport/contracts.js").DaemonConnectionClient
    | undefined;

  constructor(
    policyOrOptions:
      | DaemonPolicyValues
      | DaemonTransportPolicy
      | DaemonTransportOptions
      | TestDaemonTransportOptions = {},
  ) {
    if ("policy" in policyOrOptions) {
      this.injectedSockets = policyOrOptions.sockets;
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
    return this.server(endpoint).listen(endpoint, handler);
  }

  private server(endpoint: string) {
    if (!endpoint.endsWith(".sock") && !this.injectedSockets) return this.components.server;
    const policy = DaemonPolicy.currentSystem().values;
    return new LocalDaemonSocketServer({
      sockets: this.injectedSockets ?? new LocalDaemonSocketClient(),
      codec: new DaemonWireCodec({
        ...policy.transport,
        maximumChunkRawBytes: policy.output.maximumChunkRawBytes,
      }),
      validator: new DaemonProtocolValidator(),
      policy: policy.transport,
    });
  }

  removeUnavailableEndpoint(endpoint: string) {
    return this.server(endpoint).removeUnavailableEndpoint(endpoint);
  }
}
