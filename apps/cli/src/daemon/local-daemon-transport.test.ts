import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest } from "./daemon-protocol.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

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
    const server = await transport.listen(endpoint, async (request) => ({
      kind: "result",
      requestId: request.kind === "execute" ? request.requestId : "wrong",
      result: {
        frames: [{ stream: "stdout", bytesBase64: Buffer.from("✓\n\ntext").toString("base64") }],
        exitCode: 0,
      },
    }));

    const response = await transport.request(endpoint, {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      requestId: "request",
      request: { argv: ["resolve", "\n✓"], cwd: "/repo", telemetryEnabled: false },
    });

    expect(response).toMatchObject({ kind: "result", requestId: "request" });
    await server.close();
  });

  it("writes configured daemon frame fragments separately", () => {
    const write = vi.fn();
    const transport = new LocalDaemonTransport({ writeChunkSize: 1 });
    const frameWriter = transport as unknown as {
      writeFrame(socket: { write: typeof write }, value: unknown): void;
    };

    frameWriter.writeFrame({ write }, { kind: "stopped", instanceId: "instance" });

    expect(write.mock.calls.length).toBeGreaterThan(1);
    expect(Buffer.concat(write.mock.calls.map(([chunk]) => chunk))).toEqual(
      frame({ kind: "stopped", instanceId: "instance" }),
    );
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
    const server = await transport.listen(endpoint, async () => ({
      kind: "result",
      requestId: "different-request",
      result: { frames: [], exitCode: 0 },
    }));

    await expect(
      transport.request(endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        requestId: "expected-request",
        request: { argv: ["--version"], cwd: "/repo", telemetryEnabled: false },
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
});

function endpointFor(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-transport-"));
  roots.push(root);
  return process.platform === "win32" ? `\\\\.\\pipe\\symnav-${Date.now()}` : join(root, "d.sock");
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
