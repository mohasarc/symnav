import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
