import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonRequest } from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("LocalDaemonTransport validation", () => {
  const servers: Server[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("times out a daemon request that never receives a response", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      setTimeout(() => socket.destroy(), 50);
    });
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 10 });

    await expect(transport.request(endpoint, pingRequest())).rejects.toThrow(
      "Daemon request timed out",
    );
  });

  it("rejects malformed daemon frame JSON", async () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(1);
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(Buffer.concat([prefix, Buffer.from("{")]));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("malformed JSON");
  });

  it("rejects oversized inbound daemon frames", async () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(129);
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(prefix);
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ maximumFrameBytes: 128, requestTimeoutMs: 100 }).request(
        endpoint,
        pingRequest(),
      ),
    ).rejects.toThrow("exceeds 128 bytes");
  });

  it("rejects truncated daemon frames", async () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(10);
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.end(Buffer.concat([prefix, Buffer.from("{}")]));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("truncated frame");
  });

  it("rejects oversized outbound daemon frames", () => {
    const write = vi.fn();
    const transport = new LocalDaemonTransport({ maximumFrameBytes: 8 });
    const frameWriter = transport as unknown as {
      writeFrame(socket: { write: typeof write }, value: unknown): void;
    };

    expect(() =>
      frameWriter.writeFrame({ write }, { value: "long daemon payload" }),
    ).toThrow("exceeds 8 bytes");
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects unknown daemon response envelopes", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(frame({ kind: "unknown" }));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("Malformed daemon response");
  });

  it.each([
    { kind: "result", requestId: "request", result: { frames: [], exitCode: "invalid" } },
    {
      kind: "result",
      requestId: "request",
      result: { frames: [{ stream: "invalid", bytesBase64: "" }], exitCode: 0 },
    },
    {
      kind: "result",
      requestId: "request",
      result: { frames: [{ stream: "stdout", bytesBase64: "***" }], exitCode: 0 },
    },
  ])("rejects malformed daemon result payload %#", async (response) => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(frame(response));
      setTimeout(() => socket.destroy(), 50);
    });
    const request = {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      requestId: "request",
      request: { argv: ["--version"], cwd: "/repo", telemetryEnabled: false },
    } satisfies DaemonRequest;

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, request),
    ).rejects.toThrow("Malformed daemon result");
  });

});

function pingRequest(): DaemonRequest {
  return {
    kind: "ping",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
  };
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

async function rawServer(
  servers: Server[],
  directories: string[],
  connected: (socket: Socket) => void,
): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "symnav-transport-validation-"));
  directories.push(directory);
  const endpoint = join(directory, "daemon.sock");
  const server = createServer(connected);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return endpoint;
}
