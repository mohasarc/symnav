import { createConnection, createServer, type Server, type Socket } from "node:net";
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

  it("rejects a response kind for a different request", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(
        frame({
          kind: "result",
          requestId: "wrong",
          result: { frames: [], exitCode: 0 },
        }),
      );
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("kind does not match request");
  });

  it("rejects multiple daemon responses for one request", async () => {
    const response = frame({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      symnavVersion: "test",
    });
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(Buffer.concat([response, response]));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("multiple responses");
  });

  it("rejects invalid server requests before invoking the handler", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-transport-server-validation-"));
    directories.push(directory);
    const endpoint = join(directory, "daemon.sock");
    let handled = false;
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });
    const listening = await transport.listen(endpoint, async () => {
      handled = true;
      return { kind: "pong", protocolVersion: 1, instanceId: "instance", symnavVersion: "test" };
    });
    const socket = createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.write(frame({ kind: "ping", protocolVersion: "bad" })));
      socket.once("close", () => resolve());
    });

    expect(handled).toBe(false);
    await listening.close();
  });

  it("rejects malformed daemon pong responses", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(
        frame({
          kind: "pong",
          protocolVersion: "invalid",
          instanceId: "instance",
          symnavVersion: "test",
        }),
      );
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("Malformed daemon pong");
  });

  it("rejects malformed daemon stop responses", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(frame({ kind: "stopped" }));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, {
        kind: "stop",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      }),
    ).rejects.toThrow("Malformed daemon stop response");
  });

  it("rejects malformed daemon identity responses", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(
        frame({ kind: "identity", instanceId: "instance", processToken: "process" }),
      );
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, {
        kind: "identify",
        instanceId: "instance",
        processToken: "process",
      }),
    ).rejects.toThrow("Malformed daemon identity");
  });

  it("rejects malformed daemon termination responses", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.write(frame({ kind: "terminating", instanceId: "instance" }));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, {
        kind: "terminate",
        instanceId: "instance",
        processToken: "process",
      }),
    ).rejects.toThrow("Malformed daemon termination response");
  });

  it.each(["startedAt", "fileCount", "memoryBytes", "lastNavigationAt"] as const)(
    "rejects invalid %s pong metadata",
    async (field) => {
      const endpoint = await rawServer(servers, directories, (socket) => {
        socket.end(
          frame({
            kind: "pong",
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            instanceId: "instance",
            symnavVersion: "test",
            [field]: "invalid",
          }),
        );
      });
      const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });

      await expect(transport.request(endpoint, pingRequest())).rejects.toThrow(
        "Malformed daemon pong",
      );
    },
  );

  it("rejects nonboolean deferred telemetry requests", async () => {
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });
    const request = {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      requestId: "request",
      request: {
        argv: ["--version"],
        cwd: "/workspace",
        telemetryEnabled: false,
        deferTelemetry: "invalid",
      },
    } as unknown as DaemonRequest;

    expect(() => transport.request("/missing-daemon-endpoint", request)).toThrow(
      "Malformed daemon execute request",
    );
  });

  it("rejects malformed deferred telemetry results", async () => {
    const endpoint = await rawServer(servers, directories, (socket) => {
      socket.end(
        frame({
          kind: "result",
          requestId: "request",
          result: {
            frames: [],
            exitCode: 0,
            telemetry: { executionMode: "warm" },
          },
        }),
      );
    });
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });

    await expect(
      transport.request(endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        requestId: "request",
        request: { argv: ["--version"], cwd: "/workspace", telemetryEnabled: false },
      }),
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
