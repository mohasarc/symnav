import { describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import type { DaemonSocketClient, DaemonSocketConnection } from "./daemon-transport.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("LocalDaemonTransport socket client boundary", () => {
  it("requests lifecycle responses through the injected byte connection", async () => {
    const policy = DaemonPolicy.currentSystem();
    const codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes:
        policy.values.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
    });
    const response = codec.encodeControl({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      symnavVersion: "test",
    });
    const connection = new ScriptedDaemonSocketConnection([
      response.subarray(0, 2),
      response.subarray(2),
    ]);
    const sockets = new RecordingDaemonSocketClient(connection);
    const transport = new LocalDaemonTransport(policy.values, { sockets });

    await expect(
      transport.request("daemon-endpoint", {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      }),
    ).resolves.toMatchObject({ kind: "pong", instanceId: "instance" });

    expect(sockets.connections).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.singleResponseTimeoutMs,
      },
    ]);
    expect(connection.writes).toHaveLength(1);
    expect(connection.endCount).toBe(1);
    expect(connection.destroyCount).toBe(0);
  });
});

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
  disableTimeoutCount = 0;
  endCount = 0;
  destroyCount = 0;
  readonly incoming: AsyncIterable<Uint8Array>;

  constructor(bytes: readonly Uint8Array[]) {
    this.incoming = ScriptedDaemonSocketConnection.stream(bytes);
  }

  write(frame: Uint8Array): void {
    this.writes.push(frame);
  }

  disableTimeout(): void {
    this.disableTimeoutCount += 1;
  }

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
