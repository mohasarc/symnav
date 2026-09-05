import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import type { DaemonSocketClient, DaemonSocketConnection } from "./contracts.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest } from "./protocol.js";
import { DaemonProtocolValidator } from "./protocol-validator.js";
import { DaemonWireCodec } from "./wire-codec.js";
import { LocalDaemonSocketClient } from "./socket-client.js";
import { LocalDaemonSocketServer } from "./socket-server.js";

describe("LocalDaemonSocketServer", () => {
  const harness = new DaemonSocketServerHarness();

  afterEach(() => {
    harness.cleanUp();
  });

  it("probes endpoint reachability through the injected socket client", async () => {
    const connection = new RecordingDaemonSocketConnection();
    const sockets = new RecordingDaemonSocketClient(connection);
    const policy = DaemonPolicy.currentSystem().values;
    const server = new LocalDaemonSocketServer({
      sockets,
      codec: new DaemonWireCodec({
        maximumJsonPayloadBytes: policy.transport.maximumJsonPayloadBytes,
        maximumExecutionControlPayloadBytes: policy.transport.maximumExecutionControlPayloadBytes,
        maximumChunkRawBytes: policy.output.maximumChunkRawBytes,
      }),
      validator: new DaemonProtocolValidator(),
      policy: policy.transport,
    });

    await expect(server.removeUnavailableEndpoint("daemon-endpoint")).resolves.toBe(false);

    expect(sockets.connections).toEqual([
      {
        endpoint: "daemon-endpoint",
        timeoutMs: policy.transport.singleResponseTimeoutMs,
      },
    ]);
    expect(connection.destroyCount).toBe(1);
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

  it("waits for socket drain before writing the next fragment", async () => {
    const writes: Buffer[] = [];
    const socket = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      write: (bytes: Buffer) => boolean;
    };
    socket.destroyed = false;
    socket.write = (bytes) => {
      writes.push(bytes);
      return writes.length !== 1;
    };
    const server = harness.server({ writeChunkSize: 1 }) as unknown as {
      writeServerMessage(socket: Socket, value: unknown): Promise<void>;
    };

    const writing = server.writeServerMessage(socket as unknown as Socket, {
      kind: "stopped",
      instanceId: "instance",
    });
    await Promise.resolve();

    expect(writes).toHaveLength(1);
    socket.emit("drain");
    await writing;
    expect(Buffer.concat(writes)).toEqual(
      harness.encode({ kind: "stopped", instanceId: "instance" }),
    );
  });

  it("subscribes and unsubscribes close listeners exactly once", async () => {
    const endpoint = harness.endpoint();
    const connected = DaemonSocketServerHarness.deferred<void>();
    const notified = vi.fn();
    const removed = vi.fn();
    const server = harness.server();
    const listening = await server.listen(endpoint, async (daemonRequest, send) => {
      send.onClose(notified);
      const unsubscribe = send.onClose(removed);
      unsubscribe();
      connected.resolve();
      return harness.pong(daemonRequest.instanceId);
    });
    const client = createConnection(endpoint);
    client.once("connect", () => client.write(harness.encode(harness.ping("instance"))));

    await connected.promise;
    client.destroy();
    await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1));

    expect(removed).not.toHaveBeenCalled();
    await listening.close();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("isolates malformed and rejected requests to their connections", async () => {
    const endpoint = harness.endpoint();
    const handled: string[] = [];
    const server = harness.server();
    const listening = await server.listen(endpoint, async (daemonRequest) => {
      handled.push(daemonRequest.instanceId);
      if (daemonRequest.instanceId === "unauthorized") throw new Error("Authentication failed");
      return harness.pong(daemonRequest.instanceId);
    });

    await expect(
      harness.connectionResult(endpoint, Buffer.from([0, 0, 0, 1, 123])),
    ).resolves.toEqual(Buffer.alloc(0));
    await expect(
      harness.connectionResult(endpoint, harness.encode(harness.ping("unauthorized"))),
    ).resolves.toEqual(Buffer.alloc(0));
    await expect(harness.request(endpoint, harness.ping("healthy"))).resolves.toMatchObject({
      kind: "pong",
      instanceId: "healthy",
    });
    expect(handled).toEqual(["unauthorized", "healthy"]);
    await listening.close();
  });

  it("drains queued sends before graceful shutdown", async () => {
    const endpoint = harness.endpoint();
    const sendStarted = DaemonSocketServerHarness.deferred<void>();
    const releaseSend = DaemonSocketServerHarness.deferred<void>();
    const server = harness.server();
    const listening = await server.listen(endpoint, async (daemonRequest, send) => {
      sendStarted.resolve();
      await releaseSend.promise;
      return send(harness.pong(daemonRequest.instanceId));
    });
    const response = harness.request(endpoint, harness.ping("instance"));

    await sendStarted.promise;
    const closing = listening.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseSend.resolve();

    await expect(response).resolves.toMatchObject({ kind: "pong", instanceId: "instance" });
    await expect(closing).resolves.toBeUndefined();
  });

  it("shares concurrent graceful closes and escalates them to forced shutdown", async () => {
    const endpoint = harness.endpoint();
    const server = harness.server();
    const listening = await server.listen(endpoint, async (daemonRequest) =>
      harness.pong(daemonRequest.instanceId),
    );
    const connectionClosed = DaemonSocketServerHarness.deferred<void>();
    const client = createConnection(endpoint);
    client.once("close", () => connectionClosed.resolve());
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.once("connect", resolve);
    });

    const gracefulClose = listening.close();
    const repeatedGracefulClose = listening.close();
    let shutdownFinished = false;
    void gracefulClose.then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();

    const repeatedCloseSharedShutdown = repeatedGracefulClose === gracefulClose;
    const gracefulCloseStayedPending = !shutdownFinished;

    const forcedClose = listening.close(true);
    const forcedCloseSharedShutdown = forcedClose === gracefulClose;
    const forceClosedClient = await harness.settlesWithin(connectionClosed.promise);
    if (!forceClosedClient) client.destroy();

    await connectionClosed.promise;
    await expect(Promise.all([gracefulClose, repeatedGracefulClose, forcedClose])).resolves.toEqual(
      [undefined, undefined, undefined],
    );
    expect(repeatedCloseSharedShutdown).toBe(true);
    expect(gracefulCloseStayedPending).toBe(true);
    expect(forcedCloseSharedShutdown).toBe(true);
    expect(forceClosedClient).toBe(true);
    expect(shutdownFinished).toBe(true);
  });
});

interface SocketServerOptions {
  readonly sockets?: DaemonSocketClient;
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

  server(options: SocketServerOptions = {}): LocalDaemonSocketServer {
    const policy = DaemonPolicy.currentSystem().values;
    return new LocalDaemonSocketServer({
      sockets: options.sockets ?? new LocalDaemonSocketClient(),
      codec: this.codec(),
      validator: new DaemonProtocolValidator(),
      policy: policy.transport,
      ...(options.writeChunkSize === undefined ? {} : { writeChunkSize: options.writeChunkSize }),
    });
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

  connectionResult(endpoint: string, bytes: Uint8Array): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(endpoint);
      let received = Buffer.alloc(0);
      socket.once("error", reject);
      socket.once("connect", () => socket.write(bytes));
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      });
      socket.once("close", () => resolve(received));
    });
  }

  settlesWithin(promise: Promise<unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 250);
      void promise.then(() => {
        clearTimeout(timeout);
        resolve(true);
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

class RecordingDaemonSocketClient implements DaemonSocketClient {
  readonly connections: { readonly endpoint: string; readonly timeoutMs?: number }[] = [];

  constructor(private readonly connection: DaemonSocketConnection) {}

  connect(endpoint: string, timeoutMs?: number): Promise<DaemonSocketConnection> {
    this.connections.push({ endpoint, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return Promise.resolve(this.connection);
  }
}

class RecordingDaemonSocketConnection implements DaemonSocketConnection {
  readonly incoming: AsyncIterable<Uint8Array> = RecordingDaemonSocketConnection.empty();
  destroyCount = 0;

  write(): void {}

  disableTimeout(): void {}

  end(): void {}

  destroy(): void {
    this.destroyCount += 1;
  }

  private static async *empty(): AsyncIterable<Uint8Array> {}
}
