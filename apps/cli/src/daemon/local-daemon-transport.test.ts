import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
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
