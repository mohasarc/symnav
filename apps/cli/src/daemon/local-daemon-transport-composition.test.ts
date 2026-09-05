import { describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonExecuteRequest,
  type DaemonExecutionStatusRequest,
  type DaemonLifecycleRequest,
  type DaemonLifecycleResponse,
  type DaemonServer,
} from "./daemon-protocol.js";
import {
  DaemonClientResultCapture,
  type DaemonOutputCapture,
} from "./daemon-client-result-capture.js";
import { DaemonExecutionClient } from "./daemon-execution-client.js";
import { DaemonLifecycleClient } from "./daemon-lifecycle-client.js";
import { DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import type {
  DaemonExecutionReceipt,
  DaemonRequestHandler,
  DaemonSocketClient,
} from "./daemon-transport.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";
import { LocalDaemonSocketClient } from "./local-daemon-socket-client.js";
import { LocalDaemonSocketServer } from "./local-daemon-socket-server.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("LocalDaemonTransport composition", () => {
  it("shares one default policy, codec, validator, and socket client across split owners", () => {
    const policy = DaemonPolicy.currentSystem();
    const transport = new LocalDaemonTransport({ policy, captureDirectory: "/capture" });
    const composition = TransportCompositionInspection.read(transport);

    expect(composition.codec).toBeInstanceOf(DaemonWireCodec);
    expect(composition.validator).toBeInstanceOf(DaemonProtocolValidator);
    expect(composition.sockets).toBeInstanceOf(LocalDaemonSocketClient);
    expect(composition.lifecycle).toBeInstanceOf(DaemonLifecycleClient);
    expect(composition.execution).toBeInstanceOf(DaemonExecutionClient);
    expect(composition.server).toBeInstanceOf(LocalDaemonSocketServer);
    expect(composition.lifecycle.options).toMatchObject({
      sockets: composition.sockets,
      codec: composition.codec,
      validator: composition.validator,
      responseTimeoutMs: policy.values.transport.singleResponseTimeoutMs,
    });
    expect(composition.execution.options).toMatchObject({
      sockets: composition.sockets,
      lifecycle: composition.lifecycle,
      codec: composition.codec,
      validator: composition.validator,
      transportPolicy: policy.values.transport,
      deliveryPolicy: policy.values.delivery,
    });
    expect(composition.server.options).toMatchObject({
      sockets: composition.sockets,
      codec: composition.codec,
      validator: composition.validator,
      policy: policy.values.transport,
    });

    const firstCapture = composition.execution.options.createOutput();
    const secondCapture = composition.execution.options.createOutput();

    expect(firstCapture).toBeInstanceOf(DaemonClientResultCapture);
    expect(secondCapture).toBeInstanceOf(DaemonClientResultCapture);
    expect(secondCapture).not.toBe(firstCapture);
    expect(TransportCompositionInspection.capture(firstCapture)).toMatchObject({
      directory: "/capture",
      maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
      inlineRawBytes: policy.values.output.inlineRawBytes,
      maximumResultRawBytes: policy.values.output.maximumResultRawBytes,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.values)).toBe(true);
  });

  it("delegates every request family exactly once without replacing returned values", () => {
    const lifecycle = new RecordingLifecycleClient();
    const execution = new RecordingExecutionClient();
    const server = new RecordingRequestServer();
    const transport = new LocalDaemonTransport({
      policy: DaemonPolicy.currentSystem(),
      lifecycle,
      execution,
      server,
    });

    const lifecycleRequest = CompositionRequests.lifecycle();
    const executionStatusRequest = CompositionRequests.executionStatus();
    const executionRequest = CompositionRequests.execution();
    const handler: DaemonRequestHandler = async () => undefined;

    expect(transport.request("lifecycle-endpoint", lifecycleRequest)).toBe(lifecycle.result);
    expect(transport.executionStatus("status-endpoint", executionStatusRequest)).toBe(
      lifecycle.executionStatusResult,
    );
    expect(transport.execute("execution-endpoint", executionRequest)).toBe(execution.result);
    expect(transport.listen("server-endpoint", handler)).toBe(server.listenResult);
    expect(transport.removeUnavailableEndpoint("stale-endpoint")).toBe(server.removeResult);

    expect(lifecycle.requests).toEqual([
      { endpoint: "lifecycle-endpoint", request: lifecycleRequest },
    ]);
    expect(lifecycle.executionStatusRequests).toEqual([
      { endpoint: "status-endpoint", request: executionStatusRequest },
    ]);
    expect(execution.requests).toEqual([
      { endpoint: "execution-endpoint", request: executionRequest },
    ]);
    expect(server.listenRequests).toEqual([{ endpoint: "server-endpoint", handler }]);
    expect(server.removeRequests).toEqual(["stale-endpoint"]);
  });
});

class TransportCompositionInspection {
  static read(transport: LocalDaemonTransport): {
    codec: DaemonWireCodec;
    validator: DaemonProtocolValidator;
    sockets: DaemonSocketClient;
    lifecycle: {
      options: {
        sockets: DaemonSocketClient;
        codec: DaemonWireCodec;
        validator: DaemonProtocolValidator;
        responseTimeoutMs: number;
      };
    };
    execution: {
      options: {
        sockets: DaemonSocketClient;
        lifecycle: unknown;
        codec: DaemonWireCodec;
        validator: DaemonProtocolValidator;
        createOutput: () => DaemonOutputCapture;
        transportPolicy: ReturnType<typeof DaemonPolicy.currentSystem>["values"]["transport"];
        deliveryPolicy: ReturnType<typeof DaemonPolicy.currentSystem>["values"]["delivery"];
      };
    };
    server: {
      options: {
        sockets: DaemonSocketClient;
        codec: DaemonWireCodec;
        validator: DaemonProtocolValidator;
        policy: ReturnType<typeof DaemonPolicy.currentSystem>["values"]["transport"];
      };
    };
  } {
    return transport as unknown as ReturnType<typeof TransportCompositionInspection.read>;
  }

  static capture(capture: DaemonOutputCapture): {
    directory: string;
    maximumChunkRawBytes: number;
    inlineRawBytes: number;
    maximumResultRawBytes: number;
  } {
    return capture as unknown as ReturnType<typeof TransportCompositionInspection.capture>;
  }
}

class CompositionRequests {
  static lifecycle(): DaemonLifecycleRequest {
    return {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
    };
  }

  static executionStatus(): DaemonExecutionStatusRequest {
    return {
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "process",
      requestId: "request",
    };
  }

  static execution(): DaemonExecuteRequest {
    return {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "process",
      requestId: "request",
      commandName: "overview",
      request: {
        argv: ["overview", "src/example.ts"],
        cwd: "/workspace",
        telemetryEnabled: false,
        executionMode: "warm",
      },
    };
  }
}

class RecordingLifecycleClient {
  readonly result = Promise.resolve({
    kind: "pong" as const,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
    symnavVersion: "test",
  } satisfies DaemonLifecycleResponse);
  readonly executionStatusResult = Promise.resolve({ state: "running" as const, startedAt: 1 });
  readonly requests: Array<{ endpoint: string; request: DaemonLifecycleRequest }> = [];
  readonly executionStatusRequests: Array<{
    endpoint: string;
    request: DaemonExecutionStatusRequest;
  }> = [];

  request(endpoint: string, request: DaemonLifecycleRequest): Promise<DaemonLifecycleResponse> {
    this.requests.push({ endpoint, request });
    return this.result;
  }

  executionStatus(
    endpoint: string,
    request: DaemonExecutionStatusRequest,
  ): typeof this.executionStatusResult {
    this.executionStatusRequests.push({ endpoint, request });
    return this.executionStatusResult;
  }

  acknowledgeResult(): Promise<void> {
    return Promise.resolve();
  }
}

class RecordingExecutionClient {
  readonly result: Promise<DaemonExecutionReceipt> = Promise.resolve({
    acceptance: {
      requestId: "request",
      instanceId: "instance",
      acceptedAt: 1,
      queuePosition: 0,
    },
    completion: Promise.resolve({ status: "failed", code: "internal" }),
  });
  readonly requests: Array<{ endpoint: string; request: DaemonExecuteRequest }> = [];

  execute(endpoint: string, request: DaemonExecuteRequest): Promise<DaemonExecutionReceipt> {
    this.requests.push({ endpoint, request });
    return this.result;
  }
}

class RecordingRequestServer {
  readonly daemonServer: DaemonServer = { close: () => Promise.resolve() };
  readonly listenResult = Promise.resolve(this.daemonServer);
  readonly removeResult = Promise.resolve(true);
  readonly listenRequests: Array<{ endpoint: string; handler: DaemonRequestHandler }> = [];
  readonly removeRequests: string[] = [];

  listen(endpoint: string, handler: DaemonRequestHandler): Promise<DaemonServer> {
    this.listenRequests.push({ endpoint, handler });
    return this.listenResult;
  }

  removeUnavailableEndpoint(endpoint: string): Promise<boolean> {
    this.removeRequests.push(endpoint);
    return this.removeResult;
  }
}
