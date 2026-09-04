import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest } from "./daemon-protocol.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "../../test/helpers/local-daemon-transport.js";

describe("LocalDaemonTransport", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("listens on a daemon endpoint until closed", async () => {
    const endpoint = endpointFor(roots);
    const server = await new LocalDaemonTransport().listen(endpoint, async () => ({
      kind: "stopped",
      instanceId: "instance",
    }));

    await expect(server.close()).resolves.toBeUndefined();
  });

  it("decodes one request frame and encodes one response frame", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport();
    const server = await transport.listen(endpoint, async (request) => ({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: request.instanceId,
      symnavVersion: "test",
    }));
    const request = {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
    } satisfies DaemonRequest;

    const response = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(endpoint);
      let bytes = Buffer.alloc(0);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Daemon server closed without a response")));
      socket.once("connect", () => socket.write(frame(request)));
      socket.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        const decoded = decodeFrames(bytes)[0];
        if (decoded === undefined) return;
        socket.end();
        resolve(decoded);
      });
    });

    expect(response).toMatchObject({ kind: "pong", instanceId: "instance" });
    await server.close();
  });

  it("notifies the request handler when its client socket closes", async () => {
    const endpoint = endpointFor(roots);
    let notifyDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      notifyDisconnected = resolve;
    });
    const server = await new LocalDaemonTransport().listen(endpoint, async (request, send) => {
      send.onClose(notifyDisconnected);
      return {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: request.instanceId,
        symnavVersion: "test",
      };
    });
    const request = {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
    } satisfies DaemonRequest;

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(endpoint);
      socket.once("error", reject);
      socket.once("connect", () => socket.write(frame(request)));
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
    });

    await expect(disconnected).resolves.toBeUndefined();
    await server.close();
  });

  it("writes one client request and resolves one response", async () => {
    const endpoint = endpointFor(roots);
    const server = createServer((socket) => {
      socket.once("data", () =>
        socket.end(
          frame({
            kind: "pong",
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            instanceId: "instance",
            symnavVersion: "test",
          }),
        ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });

    await expect(
      new LocalDaemonTransport().request(endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      }),
    ).resolves.toMatchObject({ kind: "pong", instanceId: "instance" });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("round trips Unicode and arbitrary newlines through fragmented framing", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport({ writeChunkSize: 1 });
    const server = await transport.listen(endpoint, async (request, send) => {
      if (request.kind !== "execute") throw new Error("Expected execution request");
      expect(request.request.argv).toEqual(["resolve", "\n✓"]);
      send({
        kind: "accepted",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        acceptedAt: 1,
        queuePosition: 0,
      });
      send({
        kind: "execution-failed",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        code: "internal",
      });
    });

    const response = await (
      await transport.execute(endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        commandName: "resolve",
        request: {
          argv: ["resolve", "\n✓"],
          cwd: "/repo",
          telemetryEnabled: false,
          executionMode: "warm",
        },
      })
    ).completion;

    expect(response).toEqual({ status: "failed", code: "internal" });
    await server.close();
  });

  it("waits for socket drain before writing the next server fragment", async () => {
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
    const transport = new LocalDaemonTransport({ writeChunkSize: 1 });
    const serverWriter = transport as unknown as {
      writeServerMessage(socket: Socket, value: unknown): Promise<void>;
    };

    const writing = serverWriter.writeServerMessage(socket as unknown as Socket, {
      kind: "stopped",
      instanceId: "instance",
    });
    await Promise.resolve();

    expect(writes).toHaveLength(1);
    socket.emit("drain");
    await writing;
    expect(Buffer.concat(writes)).toEqual(frame({ kind: "stopped", instanceId: "instance" }));
  });

  it("decodes coalesced request frames independently", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport();
    const server = await transport.listen(endpoint, async (request) => ({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: request.instanceId,
      symnavVersion: "0.1.0",
    }));
    const first = {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "first",
    } satisfies DaemonRequest;
    const second: DaemonRequest = { ...first, instanceId: "second" };

    const responses = await new Promise<readonly unknown[]>((resolve, reject) => {
      const socket = createConnection(endpoint);
      let bytes = Buffer.alloc(0);
      socket.once("error", reject);
      socket.once("connect", () => socket.write(Buffer.concat([frame(first), frame(second)])));
      socket.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        const decoded = decodeFrames(bytes);
        if (decoded.length !== 2) return;
        socket.end();
        resolve(decoded);
      });
    });

    expect(responses).toMatchObject([
      { kind: "pong", instanceId: "first" },
      { kind: "pong", instanceId: "second" },
    ]);
    await server.close();
  });
  it("rejects wrong pong protocol and instance identifiers", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport();
    const server = await transport.listen(endpoint, async () => ({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
      instanceId: "other",
      symnavVersion: "0.0.0",
    }));

    await expect(
      transport.request(endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "expected",
      }),
    ).rejects.toThrow();
    await server.close();
  });

  it("rejects an otherwise valid execute result with a different request identifier", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport();
    const server = await transport.listen(endpoint, async (request, send) => {
      if (request.kind !== "execute") throw new Error("Expected execution request");
      send({
        kind: "accepted",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: "different-request",
        acceptedAt: 1,
        queuePosition: 0,
      });
    });

    await expect(
      transport.execute(endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        processToken: "token",
        requestId: "expected-request",
        commandName: "version",
        request: {
          argv: ["--version"],
          cwd: "/repo",
          telemetryEnabled: false,
          executionMode: "warm",
        },
      }),
    ).rejects.toThrow(/request identifier/);
    await server.close();
  });

  it("rejects an otherwise valid stop result with a different instance identifier", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport();
    const server = await transport.listen(endpoint, async () => ({
      kind: "stopped",
      instanceId: "different-instance",
    }));

    await expect(
      transport.request(endpoint, {
        kind: "stop",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "expected-instance",
      }),
    ).rejects.toThrow(/instance/);
    await server.close();
  });

  it("rejects an identity response for a different process start", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport();
    const server = await transport.listen(endpoint, async () => ({
      kind: "identity",
      instanceId: "instance",
      processToken: "different-process",
      pid: 123,
      startedAt: 10,
    }));

    await expect(
      transport.request(endpoint, {
        kind: "identify",
        instanceId: "instance",
        processToken: "expected-process",
      }),
    ).rejects.toThrow(/process instance/);
    await server.close();
  });

  it("correlates unversioned termination to the process start token", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport();
    const server = await transport.listen(endpoint, async () => ({
      kind: "terminating",
      instanceId: "instance",
      processToken: "different-process",
    }));

    await expect(
      transport.request(endpoint, {
        kind: "terminate",
        instanceId: "instance",
        processToken: "expected-process",
      }),
    ).rejects.toThrow(/process instance/);
    await server.close();
  });

  it("closes the connection when request handling fails", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });
    const server = await transport.listen(endpoint, async () => {
      throw new Error("handler failed");
    });

    await expect(
      transport.request(endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      }),
    ).rejects.toThrow();
    await server.close();
  });

  it("keeps lifecycle requests on the short timeout", async () => {
    const endpoint = endpointFor(roots);
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 10 });
    const server = await transport.listen(endpoint, async (request) => {
      await pause(30);
      return {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: request.instanceId,
        symnavVersion: "0.1.0",
      };
    });

    await expect(
      transport.request(endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      }),
    ).rejects.toThrow(/timed out/);
    await server.close();
  });

  it("does not replace a live server that owns the endpoint", async () => {
    const endpoint = endpointFor(roots);
    const first = new LocalDaemonTransport();
    const server = await first.listen(endpoint, async (request) => ({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: request.instanceId,
      symnavVersion: "0.1.0",
    }));

    await expect(
      new LocalDaemonTransport().listen(endpoint, async () => ({
        kind: "stopped",
        instanceId: "replacement",
      })),
    ).rejects.toThrow(/already in use/);
    await expect(
      first.request(endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "owner",
      }),
    ).resolves.toMatchObject({ kind: "pong", instanceId: "owner" });
    await server.close();
  });
});

function endpointFor(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-transport-"));
  roots.push(root);
  return process.platform === "win32" ? `\\\\.\\pipe\\symnav-${Date.now()}` : join(root, "d.sock");
}

function pause(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function invalidResponse(scenario: string): Buffer {
  if (scenario === "oversized") {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(129);
    return prefix;
  }
  if (scenario === "truncated") {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(10);
    return Buffer.concat([prefix, Buffer.from("{}")]);
  }
  if (scenario === "wrong-response") {
    return frame({ kind: "stopped", instanceId: "wrong" });
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(1);
  return Buffer.concat([prefix, Buffer.from("{")]);
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

function decodeFrames(bytes: Buffer): readonly unknown[] {
  const values: unknown[] = [];
  let offset = 0;
  while (bytes.length - offset >= 4) {
    const payloadLength = bytes.readUInt32BE(offset);
    if (bytes.length - offset < payloadLength + 4) break;
    values.push(
      JSON.parse(bytes.subarray(offset + 4, offset + payloadLength + 4).toString("utf8")),
    );
    offset += payloadLength + 4;
  }
  return values;
}
