import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonPolicy } from "@symnav/daemon";
import { afterEach, describe, expect, it } from "vitest";
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

  private codec(): DaemonWireCodec {
    const policy = DaemonPolicy.currentSystem().values;
    return new DaemonWireCodec({
      maximumJsonPayloadBytes: policy.transport.maximumJsonPayloadBytes,
      maximumExecutionControlPayloadBytes: policy.transport.maximumExecutionControlPayloadBytes,
      maximumChunkRawBytes: policy.output.maximumChunkRawBytes,
    });
  }
}
