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
import type {
  DaemonExecutionReceipt,
  DaemonRequestHandler,
} from "./daemon-transport.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("LocalDaemonTransport composition", () => {
  it("delegates every request family exactly once without replacing returned values", () => {
    const lifecycle = new RecordingLifecycleClient();
    const execution = new RecordingExecutionClient();
    const server = new RecordingRequestServer();
    const transport = new LocalDaemonTransport(DaemonPolicy.currentSystem().values, {
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
