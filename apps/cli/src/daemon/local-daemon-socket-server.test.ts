import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonPolicy } from "@symnav/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "../../test/helpers/local-daemon-transport.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest } from "./daemon-protocol.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";

describe("LocalDaemonTransport socket serving", () => {
  const harness = new DaemonSocketServerHarness();

  afterEach(() => {
    harness.cleanUp();
  });

  it("binds, removes stale endpoints, and refuses live endpoint replacement", async () => {
    const endpoint = harness.endpoint();
    if (process.platform !== "win32") writeFileSync(endpoint, "stale");
    const first = harness.server();

    await expect(first.removeUnavailableEndpoint(endpoint)).resolves.toBe(true);
    if (process.platform !== "win32") expect(existsSync(endpoint)).toBe(false);

    const listening = await first.listen(endpoint, async (request) =>
      harness.pong(request.instanceId),
    );
    const second = harness.server();

    await expect(second.removeUnavailableEndpoint(endpoint)).resolves.toBe(false);
    await expect(second.listen(endpoint, async () => harness.pong("replacement"))).rejects.toThrow(
      /already in use/,
    );
    await expect(harness.request(endpoint, harness.ping("owner"))).resolves.toMatchObject({
      kind: "pong",
      instanceId: "owner",
    });
    await listening.close();
  });

  it("dispatches fragmented and coalesced request frames serially", async () => {
    const endpoint = harness.endpoint();
    const firstHandler = DaemonSocketServerHarness.deferred<void>();
    const handled: string[] = [];
    const server = harness.server();
    const listening = await server.listen(endpoint, async (daemonRequest) => {
      handled.push(daemonRequest.instanceId);
      if (daemonRequest.instanceId === "first") await firstHandler.promise;
      return harness.pong(daemonRequest.instanceId);
    });
    const encoded = Buffer.concat([
      harness.encode(harness.ping("first")),
      harness.encode(harness.ping("second")),
    ]);
    const responses = harness.receiveFrames(
      endpoint,
      encoded.subarray(0, 3),
      encoded.subarray(3),
      2,
    );

    await vi.waitFor(() => expect(handled).toEqual(["first"]));
    firstHandler.resolve();

    await expect(responses).resolves.toMatchObject([
      { kind: "pong", instanceId: "first" },
      { kind: "pong", instanceId: "second" },
    ]);
    expect(handled).toEqual(["first", "second"]);
    await listening.close();
  });

  it("serializes JSON and binary sends from accepted background work", async () => {
    const endpoint = harness.endpoint();
    const releaseBackground = DaemonSocketServerHarness.deferred<void>();
    const backgroundFinished = DaemonSocketServerHarness.deferred<void>();
    const server = harness.server();
    const listening = await server.listen(endpoint, async (daemonRequest, send) => {
      if (daemonRequest.kind !== "execute") throw new Error("Expected execution request");
      await send({
        kind: "accepted",
        instanceId: daemonRequest.instanceId,
        processToken: daemonRequest.processToken,
        requestId: daemonRequest.requestId,
        acceptedAt: 1,
        queuePosition: 0,
      });
      void releaseBackground.promise.then(async () => {
        await send({
          transferId: "transfer",
          requestId: daemonRequest.requestId,
          offset: 0,
          sequence: 0,
          stream: "stdout",
          bytes: Buffer.from("background"),
        });
        backgroundFinished.resolve();
      });
    });
    const received = harness.receiveTransferFrames(endpoint, harness.executeRequest());

    releaseBackground.resolve();

    await expect(received).resolves.toMatchObject([
      { kind: "accepted", requestId: "request" },
      {
        transferId: "transfer",
        requestId: "request",
        sequence: 0,
        stream: "stdout",
        bytes: Uint8Array.from(Buffer.from("background")),
      },
    ]);
    await backgroundFinished.promise;
    await listening.close();
  });
});

interface SocketServerOptions {
  readonly writeChunkSize?: number;
}

class DaemonSocketServerHarness {
  private readonly roots: string[] = [];

  cleanUp(): void {
    for (const root of this.roots) rmSync(root, { recursive: true, force: true });
    this.roots.length = 0;
  }

  endpoint(): string {
    const root = mkdtempSync(join(tmpdir(), "symnav-socket-server-"));
    this.roots.push(root);
    return process.platform === "win32"
      ? `\\\\.\\pipe\\symnav-${Date.now()}`
      : join(root, "d.sock");
  }

  server(options: SocketServerOptions = {}): LocalDaemonTransport {
    return new LocalDaemonTransport(options);
  }

  ping(instanceId: string): DaemonRequest {
    return {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId,
    };
  }

  pong(instanceId: string) {
    return {
      kind: "pong" as const,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId,
      symnavVersion: "test",
    };
  }

  executeRequest(): DaemonRequest {
    return {
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
    };
  }

  encode(value: unknown): Buffer {
    return Buffer.from(this.codec().encodeControl(value));
  }

  request(endpoint: string, daemonRequest: DaemonRequest): Promise<unknown> {
    return this.receiveFrames(endpoint, this.encode(daemonRequest), Buffer.alloc(0), 1).then(
      (responses) => responses[0],
    );
  }

  receiveFrames(
    endpoint: string,
    first: Uint8Array,
    second: Uint8Array,
    count: number,
  ): Promise<readonly unknown[]> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(endpoint);
      let bytes = Buffer.alloc(0);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(first);
        socket.write(second);
      });
      socket.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        const values = this.codec().controlDecoder().append(bytes);
        if (values.length !== count) return;
        socket.end();
        resolve(values);
      });
    });
  }

  receiveTransferFrames(
    endpoint: string,
    daemonRequest: DaemonRequest,
  ): Promise<readonly unknown[]> {
    return new Promise((resolve, reject) => {
      const decoder = this.codec().transferDecoder();
      const frames: unknown[] = [];
      const socket = createConnection(endpoint);
      socket.once("error", reject);
      socket.once("connect", () => socket.write(this.encode(daemonRequest)));
      socket.on("data", (bytes) => {
        frames.push(...decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
        if (frames.length !== 2) return;
        socket.end();
        resolve(frames);
      });
    });
  }

  static deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  private codec(): DaemonWireCodec {
    const policy = DaemonPolicy.currentSystem().values;
    return new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes: policy.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.output.maximumChunkRawBytes,
    });
  }
}
