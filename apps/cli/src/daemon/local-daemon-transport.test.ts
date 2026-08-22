import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
