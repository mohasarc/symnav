import { describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonExecutionClient } from "./daemon-execution-client.js";
import type { DaemonOutputCapture } from "./daemon-client-result-capture.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonExecuteRequest,
  type DaemonExecutionServerFrame,
} from "./daemon-protocol.js";
import { DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import type { DaemonSocketClient, DaemonSocketConnection } from "./daemon-transport.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";

describe("DaemonExecutionClient", () => {
  it("owns one accepted execution attempt through terminal failure", async () => {
    const policy = DaemonPolicy.currentSystem();
    const codec = executionCodec();
    const request = executionRequest();
    const connection = new ScriptedDaemonSocketConnection([
      Buffer.concat([
        codec.encodeControl({
          kind: "accepted",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          acceptedAt: 10,
          queuePosition: 0,
        } satisfies DaemonExecutionServerFrame),
        codec.encodeControl({
          kind: "execution-failed",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "internal",
        } satisfies DaemonExecutionServerFrame),
      ]),
    ]);
    const sockets = new RecordingDaemonSocketClient([connection]);
    const output = new RecordingDaemonOutputCapture();
    const acknowledgements = new RecordingResultAcknowledger();
    const client = new DaemonExecutionClient({
      sockets,
      lifecycle: acknowledgements,
      codec,
      validator: new DaemonProtocolValidator(),
      createOutput: () => output,
      transportPolicy: policy.values.transport,
      deliveryPolicy: policy.values.delivery,
    });

    const receipt = await client.execute("daemon-endpoint", request);

    expect(receipt.acceptance).toEqual({
      requestId: request.requestId,
      instanceId: request.instanceId,
      acceptedAt: 10,
      queuePosition: 0,
    });
    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
    expect(sockets.calls).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.executionAdmissionTimeoutMs,
      },
    ]);
    expect(connection.writes).toEqual([codec.encodeControl(request)]);
    expect(connection.disableTimeoutCount).toBe(1);
    expect(connection.endCount).toBe(1);
    expect(output.disposeCount).toBe(1);
    expect(acknowledgements.count).toBe(0);
  });

  it("reattaches an accepted close with the identical execute request", async () => {
    const policy = DaemonPolicy.currentSystem();
    const codec = executionCodec();
    const request = executionRequest();
    const first = new ScriptedDaemonSocketConnection([
      codec.encodeControl({
        kind: "accepted",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        acceptedAt: 10,
        queuePosition: 0,
      } satisfies DaemonExecutionServerFrame),
    ]);
    const second = new ScriptedDaemonSocketConnection([
      Buffer.concat([
        codec.encodeControl({
          kind: "accepted",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          acceptedAt: 10,
          queuePosition: 0,
        } satisfies DaemonExecutionServerFrame),
        codec.encodeControl({
          kind: "execution-failed",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "internal",
        } satisfies DaemonExecutionServerFrame),
      ]),
    ]);
    const sockets = new RecordingDaemonSocketClient([first, second]);
    const outputs: RecordingDaemonOutputCapture[] = [];
    const client = new DaemonExecutionClient({
      sockets,
      lifecycle: new RecordingResultAcknowledger(),
      codec,
      validator: new DaemonProtocolValidator(),
      createOutput: () => {
        const output = new RecordingDaemonOutputCapture();
        outputs.push(output);
        return output;
      },
      transportPolicy: policy.values.transport,
      deliveryPolicy: policy.values.delivery,
    });

    const receipt = await client.execute("daemon-endpoint", request);

    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
    expect(sockets.calls).toHaveLength(2);
    expect(first.writes).toEqual([codec.encodeControl(request)]);
    expect(second.writes).toEqual([codec.encodeControl(request)]);
    expect(outputs.map((output) => output.disposeCount)).toEqual([1, 1]);
  });
});

class RecordingDaemonSocketClient implements DaemonSocketClient {
  readonly calls: { readonly endpoint: string; readonly timeoutMs?: number }[] = [];
  private nextConnection = 0;

  constructor(private readonly connections: readonly DaemonSocketConnection[]) {}

  connect(endpoint: string, timeoutMs?: number): Promise<DaemonSocketConnection> {
    this.calls.push({ endpoint, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const connection = this.connections[this.nextConnection];
    this.nextConnection += 1;
    if (connection === undefined) return Promise.reject(new Error("Unexpected daemon connection"));
    return Promise.resolve(connection);
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

class RecordingDaemonOutputCapture implements DaemonOutputCapture {
  disposeCount = 0;

  append(): Promise<void> {
    return Promise.resolve();
  }

  finish(): Promise<never> {
    return Promise.reject(new Error("Unexpected output completion"));
  }

  dispose(): Promise<void> {
    this.disposeCount += 1;
    return Promise.resolve();
  }
}

class RecordingResultAcknowledger {
  count = 0;

  acknowledgeResult(): Promise<void> {
    this.count += 1;
    return Promise.resolve();
  }
}

function executionCodec(): DaemonWireCodec {
  const policy = DaemonPolicy.currentSystem();
  return new DaemonWireCodec({
    maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
    maximumExecutionControlPayloadBytes:
      policy.values.transport.maximumExecutionControlPayloadBytes,
    maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
  });
}

function executionRequest(): DaemonExecuteRequest {
  return {
    kind: "execute",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
    processToken: "token",
    requestId: "request",
    commandName: "overview",
    request: {
      argv: ["overview", "src/a.ts"],
      cwd: "/repo",
      telemetryEnabled: false,
      executionMode: "warm",
    },
  };
}
