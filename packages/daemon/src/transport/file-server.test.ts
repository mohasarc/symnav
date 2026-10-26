import { randomUUID } from "node:crypto";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import { FileDaemonEndpoint } from "./file-endpoint.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "../daemon-policy.js";
import { DaemonTransportFactory } from "./daemon-transport.js";
import { FileDaemonRequestServer } from "./file-server.js";
import { FileDaemonConnectionClient } from "./file-connection-client.js";
import { DaemonWireCodec } from "./wire-codec.js";
import { DAEMON_PROTOCOL_VERSION } from "./protocol.js";

class FileServerHarness {
  public readonly roots: string[] = [];
  public readonly policy = DaemonPolicy.currentSystem();
  public readonly codec = new DaemonWireCodec({
    ...this.policy.values.transport,
    maximumChunkRawBytes: this.policy.values.output.maximumChunkRawBytes,
  });
  public async endpoint(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "symnav-file-server-"));
    this.roots.push(root);
    return join(root, "endpoint");
  }
  public async cleanUp(): Promise<void> {
    for (const root of this.roots.splice(0)) await rm(root, { recursive: true, force: true });
  }
  public ping(instanceId: string) {
    return { kind: "ping" as const, instanceId, protocolVersion: DAEMON_PROTOCOL_VERSION };
  }
  public pong(instanceId: string) {
    return {
      kind: "pong" as const,
      instanceId,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "test",
    };
  }
}

describe.skipIf(process.platform === "win32")("filesystem daemon server", () => {
  const harness = new FileServerHarness();
  afterEach(() => harness.cleanUp());

  it("uses filesystem composition and services independent ordered clients", async () => {
    const endpoint = await harness.endpoint();
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    expect(transport.server).toBeInstanceOf(FileDaemonRequestServer);
    const handled: string[] = [];
    const listening = await transport.server.listen(endpoint, async (request) => {
      handled.push(request.instanceId);
      return harness.pong(request.instanceId);
    });
    const first = transport.lifecycle.request(endpoint, harness.ping("first"));
    const second = transport.lifecycle.request(endpoint, harness.ping("second"));
    await expect(first).resolves.toMatchObject(harness.pong("first"));
    await expect(second).resolves.toMatchObject(harness.pong("second"));
    expect(handled.sort()).toEqual(["first", "second"]);
    await listening.close();
    expect(await readdir(join(endpoint, ".."))).toEqual(["process-lifetimes"]);
  });

  it("connects to a live endpoint whose PID is absent in the caller namespace", async () => {
    const endpoint = await harness.endpoint();
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    const listening = await transport.server.listen(endpoint, async (request) =>
      harness.pong(request.instanceId),
    );
    const owner = await FileDaemonEndpoint.owner(endpoint);
    await writeFile(
      join(owner.directory, "owner.json"),
      JSON.stringify({ ...owner, pid: 2147483647 }),
    );
    try {
      await expect(
        transport.lifecycle.request(endpoint, harness.ping("foreign")),
      ).resolves.toMatchObject({ kind: "pong" });
      await expect(transport.server.removeUnavailableEndpoint(endpoint)).resolves.toBe(false);
    } finally {
      await listening.close(true);
    }
  });

  it("never removes a live endpoint because responses are slow", async () => {
    const endpoint = await harness.endpoint();
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    const listening = await transport.server.listen(endpoint, async () => {});
    await expect(transport.server.removeUnavailableEndpoint(endpoint)).resolves.toBe(false);
    await expect(transport.server.listen(endpoint, async () => {})).rejects.toThrow(
      /already in use/,
    );
    await listening.close(true);
  });

  it("drains graceful close and notifies listener once after client closes", async () => {
    const endpoint = await harness.endpoint();
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    const notified = vi.fn();
    const listening = await transport.server.listen(endpoint, async (request, send) => {
      send.onClose(notified);
      return harness.pong(request.instanceId);
    });
    const client = await new FileDaemonConnectionClient({
      policy: harness.policy.values.transport,
    }).connect(endpoint);
    await client.write(harness.codec.encodeControl(harness.ping("instance")));
    const incoming = client.incoming[Symbol.asyncIterator]();
    await incoming.next();
    const closing = listening.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    client.end();
    await incoming.next();
    await closing;
    expect(notified).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it.each(["before-owner", "after-owner"])(
    "reaps an interrupted publisher %s while preserving live publication and healthy traffic",
    async (publicationWindow) => {
      const endpoint = await harness.endpoint();
      const transport = DaemonTransportFactory.create({ policy: harness.policy });
      const listening = await transport.server.listen(endpoint, async (request) =>
        harness.pong(request.instanceId),
      );
      const ownerDirectory = (await FileDaemonEndpoint.owner(endpoint)).directory;
      const lifetime = PosixDaemonProcessLifetime.prepareChild(join(endpoint, ".."));
      const publisher = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import { mkdir, writeFile } from "node:fs/promises";
          import { join } from "node:path";
          import { randomUUID } from "node:crypto";
          const name = String(Date.now()).padStart(16, "0") + "-" +
            String(process.pid).padStart(10, "0") + "-0000000000-" + JSON.parse(process.argv[3]).token + ".tmp";
          const directory = join(process.argv[1], name);
          await mkdir(directory);
          if (process.argv[2] === "after-owner") {
            await mkdir(join(directory, "request"));
            await mkdir(join(directory, "response"));
            await writeFile(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token: randomUUID(), processLifetime: JSON.parse(process.argv[3]) }));
          }
          console.log(name);
          setInterval(() => {}, 1000);
        `,
          ownerDirectory,
          publicationWindow,
          JSON.stringify(lifetime.identity),
        ],
        { stdio: ["ignore", "pipe", "ignore", lifetime.descriptor] },
      );
      try {
        const [bytes] = await once(publisher.stdout!, "data");
        lifetime.closeParentCopy();
        const name = String(bytes).trim();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(await readdir(ownerDirectory)).toContain(name);
        await expect(
          transport.lifecycle.request(endpoint, harness.ping("while-publishing")),
        ).resolves.toMatchObject({ kind: "pong" });
        const exited = once(publisher, "exit");
        publisher.kill("SIGKILL");
        await exited;
        await vi.waitFor(async () => expect(await readdir(ownerDirectory)).not.toContain(name));
        await expect(
          transport.lifecycle.request(endpoint, harness.ping("after-interruption")),
        ).resolves.toMatchObject({ kind: "pong" });
      } finally {
        lifetime.closeParentCopy();
        publisher.kill("SIGKILL");
        await listening.close(true);
      }
    },
  );

  it("cleans acknowledgement channels while peers finish closing", async () => {
    const endpoint = await harness.endpoint();
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    const listening = await transport.server.listen(endpoint, async (request) => {
      if (request.kind !== "result-ack") throw new Error("Expected acknowledgement");
      return {
        kind: "result-acknowledged",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        transferId: request.transferId,
      };
    });
    for (let index = 0; index < 200; index += 1) {
      await transport.lifecycle.acknowledgeResult(
        endpoint,
        {
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          instanceId: "instance",
          processToken: "token",
          requestId: `request-${index}`,
        },
        "transfer",
      );
    }
    await listening.close();
    expect(await readdir(join(endpoint, ".."))).toEqual(["process-lifetimes"]);
  }, 10_000);

  it("isolates malformed and abandoned channels while preserving the listener", async () => {
    const endpoint = await harness.endpoint();
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    const listening = await transport.server.listen(endpoint, async (request) =>
      harness.pong(request.instanceId),
    );
    const ownerDirectory = (await FileDaemonEndpoint.owner(endpoint)).directory;
    for (const [name, owner] of [
      ["1.channel", "broken"],
      ["2.channel", JSON.stringify({ pid: 2147483647 })],
    ] as const) {
      await mkdir(join(ownerDirectory, name));
      await writeFile(join(ownerDirectory, name, "owner.json"), owner);
    }
    await vi.waitFor(async () =>
      expect((await readdir(ownerDirectory)).filter((name) => name.endsWith(".channel"))).toEqual(
        [],
      ),
    );
    await expect(
      transport.lifecycle.request(endpoint, harness.ping("healthy")),
    ).resolves.toMatchObject({ kind: "pong" });
    await listening.close(true);
  });

  it("shares graceful close and forcefully interrupts an idle accepted channel", async () => {
    const endpoint = await harness.endpoint();
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    const listening = await transport.server.listen(endpoint, async () => {});
    const client = await new FileDaemonConnectionClient({
      policy: harness.policy.values.transport,
    }).connect(endpoint);
    await client.write(harness.codec.encodeControl(harness.ping("idle")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closing = listening.close();
    expect(listening.close()).toBe(closing);
    expect(listening.close(true)).toBe(closing);
    await closing;
    await expect(client.incoming[Symbol.asyncIterator]().next()).rejects.toThrow(/closed/);
    client.destroy();
  });

  it("removes only endpoints with a proven dead owner", async () => {
    const endpoint = await harness.endpoint();
    const lifetime = PosixDaemonProcessLifetime.prepareChild(join(endpoint, ".."));
    lifetime.closeParentCopy();
    const token = randomUUID();
    await mkdir(join(endpoint, token), { recursive: true });
    await writeFile(
      join(endpoint, token, "owner.json"),
      JSON.stringify({ pid: process.pid, token, processLifetime: lifetime.identity }),
    );
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    await expect(transport.server.removeUnavailableEndpoint(endpoint)).resolves.toBe(true);
  });
});
