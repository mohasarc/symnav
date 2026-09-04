import { describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonLifecycleClient } from "./daemon-lifecycle-client.js";
import type {
  DaemonExecutionStatusRequest,
  DaemonExecutionStatusResponse,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import { DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import type { DaemonSocketClient, DaemonSocketConnection } from "./daemon-transport.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";

describe("DaemonLifecycleClient", () => {
  it.each([
    [
      {
        kind: "identify",
        instanceId: "instance",
        processToken: "token",
      },
      {
        kind: "identity",
        instanceId: "instance",
        processToken: "token",
        pid: 123,
        startedAt: 10,
      },
    ],
    [
      {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      },
      {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        symnavVersion: "test",
      },
    ],
    [
      {
        kind: "terminate",
        instanceId: "instance",
        processToken: "token",
      },
      { kind: "terminating", instanceId: "instance", processToken: "token" },
    ],
    [
      {
        kind: "kill",
        instanceId: "instance",
        processToken: "token",
      },
      { kind: "killing", instanceId: "instance", processToken: "token" },
    ],
    [
      {
        kind: "stop",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      },
      { kind: "stopped", instanceId: "instance" },
    ],
  ] satisfies readonly (readonly [DaemonLifecycleRequest, DaemonLifecycleResponse])[])(
    "exchanges one correlated $0.kind response",
    async (request, response) => {
      const harness = LifecycleClientHarness.responding(response);

      await expect(harness.client.request("daemon-endpoint", request)).resolves.toEqual(response);

      expect(harness.sockets.connections).toEqual([
        { endpoint: "daemon-endpoint", timeoutMs: harness.responseTimeoutMs },
      ]);
      expect(harness.connection.writes).toEqual([harness.codec.encodeControl(request)]);
      expect(harness.connection.endCount).toBe(1);
      expect(harness.connection.destroyCount).toBe(0);
    },
  );

  it("exchanges one correlated execution-status response", async () => {
    const request: DaemonExecutionStatusRequest = {
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
    };
    const response = {
      kind: "execution-status" as const,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      status: { state: "running" as const, startedAt: 20 },
    } satisfies DaemonExecutionStatusResponse;
    const harness = LifecycleClientHarness.responding(response);

    await expect(harness.client.executionStatus("daemon-endpoint", request)).resolves.toEqual(
      response.status,
    );

    expect(harness.sockets.connections).toEqual([
      { endpoint: "daemon-endpoint", timeoutMs: harness.responseTimeoutMs },
    ]);
    expect(harness.connection.writes).toEqual([harness.codec.encodeControl(request)]);
    expect(harness.connection.endCount).toBe(1);
    expect(harness.connection.destroyCount).toBe(0);
  });

  it.each([
    ["missing", []],
    [
      "duplicate",
      [
        Buffer.concat([
          lifecycleCodec().encodeControl(pongResponse()),
          lifecycleCodec().encodeControl(pongResponse()),
        ]),
      ],
    ],
    ["wrong-kind", [lifecycleCodec().encodeControl({ kind: "stopped", instanceId: "instance" })]],
    [
      "wrong-instance",
      [lifecycleCodec().encodeControl({ ...pongResponse(), instanceId: "other" })],
    ],
    ["malformed", [Buffer.from([0, 0, 0, 1, 123])]],
    ["truncated", [Buffer.from([0, 0, 0, 2, 123])]],
    ["oversized", [oversizedFramePrefix()]],
  ] as const)(
    "rejects a %s lifecycle response and destroys its connection",
    async (_name, bytes) => {
      const harness = LifecycleClientHarness.receiving(bytes);

      await expect(harness.client.request("daemon-endpoint", pingRequest())).rejects.toBeInstanceOf(
        Error,
      );

      expect(harness.connection.endCount).toBe(0);
      expect(harness.connection.destroyCount).toBe(1);
    },
  );

  it("rejects a wrong identity token and destroys its connection", async () => {
    const harness = LifecycleClientHarness.responding({
      kind: "identity",
      instanceId: "instance",
      processToken: "other",
      pid: 123,
      startedAt: 10,
    });

    await expect(
      harness.client.request("daemon-endpoint", {
        kind: "identify",
        instanceId: "instance",
        processToken: "token",
      }),
    ).rejects.toMatchObject({ code: "authentication", delivery: "accepted" });

    expect(harness.connection.endCount).toBe(0);
    expect(harness.connection.destroyCount).toBe(1);
  });

  it("rejects wrong execution-status request correlation and destroys its connection", async () => {
    const harness = LifecycleClientHarness.responding({
      kind: "execution-status",
      instanceId: "instance",
      processToken: "token",
      requestId: "other",
      status: { state: "unknown" },
    });

    await expect(
      harness.client.executionStatus("daemon-endpoint", {
        kind: "execution-status",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(harness.connection.endCount).toBe(0);
    expect(harness.connection.destroyCount).toBe(1);
  });
});

class LifecycleClientHarness {
  readonly responseTimeoutMs = 321;
  readonly codec: DaemonWireCodec;
  readonly connection: ScriptedDaemonSocketConnection;
  readonly sockets: RecordingDaemonSocketClient;
  readonly client: DaemonLifecycleClient;

  private constructor(incoming: readonly Uint8Array[]) {
    this.codec = lifecycleCodec();
    this.connection = new ScriptedDaemonSocketConnection(incoming);
    this.sockets = new RecordingDaemonSocketClient(this.connection);
    this.client = new DaemonLifecycleClient({
      sockets: this.sockets,
      codec: this.codec,
      validator: new DaemonProtocolValidator(),
      responseTimeoutMs: this.responseTimeoutMs,
    });
  }

  static responding(response: unknown): LifecycleClientHarness {
    const codec = lifecycleCodec();
    return new LifecycleClientHarness([codec.encodeControl(response)]);
  }

  static receiving(incoming: readonly Uint8Array[]): LifecycleClientHarness {
    return new LifecycleClientHarness(incoming);
  }
}

class RecordingDaemonSocketClient implements DaemonSocketClient {
  readonly connections: { readonly endpoint: string; readonly timeoutMs?: number }[] = [];

  constructor(private readonly connection: DaemonSocketConnection) {}

  connect(endpoint: string, timeoutMs?: number): Promise<DaemonSocketConnection> {
    this.connections.push({ endpoint, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return Promise.resolve(this.connection);
  }
}

class ScriptedDaemonSocketConnection implements DaemonSocketConnection {
  readonly writes: Uint8Array[] = [];
  endCount = 0;
  destroyCount = 0;
  readonly incoming: AsyncIterable<Uint8Array>;

  constructor(bytes: readonly Uint8Array[]) {
    this.incoming = ScriptedDaemonSocketConnection.stream(bytes);
  }

  write(frame: Uint8Array): void {
    this.writes.push(frame);
  }

  disableTimeout(): void {}

  end(): void {
    this.endCount += 1;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  private static async *stream(bytes: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
    yield* bytes;
  }
}

function lifecycleCodec(): DaemonWireCodec {
  const policy = DaemonPolicy.currentSystem();
  return new DaemonWireCodec({
    maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
    maximumExecutionControlPayloadBytes:
      policy.values.transport.maximumExecutionControlPayloadBytes,
    maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
  });
}

function pingRequest(): DaemonLifecycleRequest {
  return {
    kind: "ping",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
  };
}

function pongResponse(): DaemonLifecycleResponse {
  return {
    kind: "pong",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
    symnavVersion: "test",
  };
}

function oversizedFramePrefix(): Uint8Array {
  const policy = DaemonPolicy.currentSystem();
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(policy.values.transport.maximumJsonPayloadBytes + 1);
  return prefix;
}
