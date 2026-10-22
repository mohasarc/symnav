import { describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "../../test/helpers/daemon-policy.js";
import type { DaemonSocketClient, DaemonSocketConnection } from "./contracts.js";
import { DAEMON_PROTOCOL_VERSION } from "./protocol.js";
import { DaemonWireCodec } from "./wire-codec.js";
import { TestDaemonTransport as DaemonTransport } from "../../test/helpers/daemon-transport.js";

describe("DaemonTransport socket client boundary", () => {
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
    const transport = new DaemonTransport({ policy, sockets });

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

  it("composes daemon-status lifecycle requests with the observer timeout", async () => {
    const policy = DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
      transport: {
        singleResponseTimeoutMs: 503,
        statusResponseTimeoutMs: 97,
        executionAdmissionTimeoutMs: 97,
      },
    });
    const codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes:
        policy.values.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
    });
    const connection = new ScriptedDaemonSocketConnection([
      codec.encodeControl({
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        symnavVersion: "test",
      }),
    ]);
    const sockets = new RecordingDaemonSocketClient(connection);
    const transport = new DaemonTransport({
      policy,
      sockets,
      lifecycleResponseTimeoutMs: policy.values.transport.statusResponseTimeoutMs,
    });

    await transport.request("daemon-endpoint", {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
    });

    expect(sockets.connections).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.statusResponseTimeoutMs,
      },
    ]);
  });

  it("composes execution-status requests with the ordinary response timeout", async () => {
    const policy = DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
      transport: {
        singleResponseTimeoutMs: 503,
        statusResponseTimeoutMs: 97,
        executionAdmissionTimeoutMs: 97,
      },
    });
    const codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes:
        policy.values.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
    });
    const connection = new ScriptedDaemonSocketConnection([
      codec.encodeControl({
        kind: "execution-status",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        status: { state: "unknown" },
      }),
    ]);
    const sockets = new RecordingDaemonSocketClient(connection);
    const transport = new DaemonTransport({ policy, sockets });

    await transport.executionStatus("daemon-endpoint", {
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
    });

    expect(sockets.connections).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.singleResponseTimeoutMs,
      },
    ]);
  });

  it("receives execution frames through the injected byte connection", async () => {
    const policy = DaemonPolicy.currentSystem();
    const codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes:
        policy.values.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
    });
    const accepted = codec.encodeServerMessage({
      kind: "accepted",
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      acceptedAt: 1,
      queuePosition: 0,
    });
    const failed = codec.encodeServerMessage({
      kind: "execution-failed",
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      code: "internal",
    });
    const connection = new ScriptedDaemonSocketConnection([Buffer.concat([accepted, failed])]);
    const sockets = new RecordingDaemonSocketClient(connection);
    const transport = new DaemonTransport({ policy, sockets });

    const receipt = await transport.execute("daemon-endpoint", {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      commandName: "version",
      request: {
        argv: ["--version"],
        cwd: "/repo",
        telemetryEnabled: false,
        executionMode: "warm",
      },
    });

    expect(receipt.acceptance).toMatchObject({ requestId: "request", instanceId: "instance" });
    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
    expect(sockets.connections).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.executionAdmissionTimeoutMs,
      },
    ]);
    expect(connection.writes).toHaveLength(1);
    expect(connection.disableTimeoutCount).toBe(1);
    expect(connection.endCount).toBe(1);
  });

  it("resumes and acknowledges results through fresh injected byte connections", async () => {
    const policy = DaemonPolicy.currentSystem();
    const codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.values.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes:
        policy.values.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.values.output.maximumChunkRawBytes,
    });
    const manifest = {
      transferId: "transfer",
      requestId: "request",
      instanceId: "instance",
      exitCode: 0,
      rawBytes: 0,
      recordCount: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    } satisfies import("../delivery/completion-spool.js").CompletionSpoolManifest;
    const acceptanceAndManifest = new ScriptedDaemonSocketConnection([
      Buffer.concat([
        codec.encodeServerMessage({
          kind: "accepted",
          instanceId: "instance",
          processToken: "token",
          requestId: "request",
          acceptedAt: 1,
          queuePosition: 0,
        }),
        codec.encodeServerMessage({
          kind: "result-manifest",
          instanceId: "instance",
          processToken: "token",
          requestId: "request",
          manifest,
        }),
      ]),
    ]);
    const resumedResult = new ScriptedDaemonSocketConnection([
      Buffer.concat([
        codec.encodeServerMessage({
          kind: "result-manifest",
          instanceId: "instance",
          processToken: "token",
          requestId: "request",
          manifest,
        }),
        codec.encodeServerMessage({
          kind: "result-end",
          instanceId: "instance",
          processToken: "token",
          requestId: "request",
          transferId: "transfer",
          rawBytes: 0,
          recordCount: 0,
          sha256: manifest.sha256,
        }),
      ]),
    ]);
    const acknowledgement = new ScriptedDaemonSocketConnection([
      codec.encodeControl({
        kind: "result-acknowledged",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        transferId: "transfer",
      }),
    ]);
    const sockets = new RecordingDaemonSocketClient(
      acceptanceAndManifest,
      resumedResult,
      acknowledgement,
    );
    const transport = new DaemonTransport({ policy, sockets });

    const receipt = await transport.execute("daemon-endpoint", {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      commandName: "version",
      request: {
        argv: ["--version"],
        cwd: "/repo",
        telemetryEnabled: false,
        executionMode: "warm",
      },
    });
    const completion = await receipt.completion;

    expect(completion).toMatchObject({ status: "completed", result: { exitCode: 0 } });
    expect(sockets.connections).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.executionAdmissionTimeoutMs,
      },
      { endpoint: "daemon-endpoint" },
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.singleResponseTimeoutMs,
      },
    ]);
    expect(acceptanceAndManifest.destroyCount).toBe(1);
    expect(resumedResult.endCount).toBe(1);
    expect(acknowledgement.endCount).toBe(1);
    if (completion.status === "completed") await completion.result.output.dispose();
  });

  it("probes endpoint reachability through the injected socket client", async () => {
    const policy = DaemonPolicy.currentSystem();
    const connection = new ScriptedDaemonSocketConnection([]);
    const sockets = new RecordingDaemonSocketClient(connection);
    const transport = new DaemonTransport({ policy, sockets });

    await expect(transport.removeUnavailableEndpoint("daemon-endpoint")).resolves.toBe(false);

    expect(sockets.connections).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.values.transport.singleResponseTimeoutMs,
      },
    ]);
    expect(connection.destroyCount).toBe(1);
  });
});

class RecordingDaemonSocketClient implements DaemonSocketClient {
  readonly connections: { readonly endpoint: string; readonly timeoutMs?: number }[] = [];
  private readonly scriptedConnections: DaemonSocketConnection[];

  constructor(...connections: DaemonSocketConnection[]) {
    this.scriptedConnections = [...connections];
  }

  connect(endpoint: string, timeoutMs?: number): Promise<DaemonSocketConnection> {
    this.connections.push({ endpoint, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const connection = this.scriptedConnections.shift();
    if (connection === undefined) throw new Error("No scripted daemon socket connection");
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
