import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonPolicy } from "../daemon-policy.js";
import { DaemonCompletionSpoolStore } from "../delivery/completion-spool.js";
import type { DaemonConnection, DaemonConnectionClient } from "./contracts.js";
import { FileDaemonConnectionClient } from "./file-connection-client.js";
import { DaemonTransportFactory } from "./daemon-transport.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonExecuteRequest,
  type DaemonServer,
} from "./protocol.js";

class FileProtocolHarness {
  public readonly policy = DaemonPolicy.currentSystem();
  public readonly roots: string[] = [];
  public readonly servers: DaemonServer[] = [];
  public readonly request: DaemonExecuteRequest = {
    kind: "execute",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
    processToken: "token",
    requestId: "request",
    commandName: "overview",
    request: {
      argv: ["overview", "input.ts"],
      cwd: "/repo",
      telemetryEnabled: false,
      executionMode: "warm",
    },
  };
  public async root(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "symnav-file-conformance-"));
    this.roots.push(root);
    return root;
  }
  public async cleanUp(): Promise<void> {
    for (const server of this.servers.splice(0)) await server.close(true);
    for (const root of this.roots.splice(0)) await rm(root, { recursive: true, force: true });
  }
}

class InterruptedFileClient implements DaemonConnectionClient {
  private connections = 0;
  private readonly client: FileDaemonConnectionClient;
  public constructor(policy: DaemonPolicy) {
    this.client = new FileDaemonConnectionClient({ policy: policy.values.transport });
  }
  public async connect(endpoint: string, timeoutMs?: number): Promise<DaemonConnection> {
    const connection = await this.client.connect(endpoint, timeoutMs);
    if (this.connections++ !== 0) return connection;
    return new InterruptedFileConnection(connection);
  }
}

class InterruptedFileConnection implements DaemonConnection {
  public readonly incoming: AsyncIterable<Uint8Array>;
  public constructor(private readonly connection: DaemonConnection) {
    this.incoming = this.receive();
  }
  public write(bytes: Uint8Array): void | Promise<void> {
    return this.connection.write(bytes);
  }
  public disableTimeout(): void {
    this.connection.disableTimeout();
  }
  public end(): void {
    this.connection.end();
  }
  public destroy(): void {
    this.connection.destroy();
  }
  private async *receive(): AsyncIterable<Uint8Array> {
    let bytesReceived = 0;
    for await (const bytes of this.connection.incoming) {
      bytesReceived += bytes.byteLength;
      yield bytes;
      if (bytesReceived > 100_000) {
        this.connection.destroy();
        return;
      }
    }
  }
}

describe.skipIf(process.platform === "win32")("filesystem execution protocol", () => {
  const harness = new FileProtocolHarness();
  afterEach(() => harness.cleanUp());

  it("permits local retry only before submission", async () => {
    const endpoint = join(await harness.root(), "endpoint");
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    await expect(transport.execution.execute(endpoint, harness.request)).rejects.toMatchObject({
      delivery: "not-submitted",
      retrySafe: true,
    });
    harness.servers.push(
      await transport.server.listen(endpoint, async () => {
        throw new Error("Lost acceptance");
      }),
    );
    await expect(transport.execution.execute(endpoint, harness.request)).rejects.toMatchObject({
      delivery: "submitted-unconfirmed",
      retrySafe: false,
    });
  });

  it("retains authenticated admission rejection semantics", async () => {
    const endpoint = join(await harness.root(), "endpoint");
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    harness.servers.push(
      await transport.server.listen(endpoint, async (request) => {
        if (request.kind !== "execute") throw new Error("Expected execution");
        return {
          kind: "rejected",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "not-ready",
          retrySafe: true,
        };
      }),
    );
    await expect(transport.execution.execute(endpoint, harness.request)).rejects.toMatchObject({
      code: "rejected",
      delivery: "submitted-unconfirmed",
      retrySafe: true,
      authenticatedInstanceId: "instance",
    });
  });

  it("keeps lifecycle requests responsive and accepted work alive beyond lifecycle deadlines", async () => {
    const endpoint = join(await harness.root(), "endpoint");
    const transport = DaemonTransportFactory.create({ policy: harness.policy });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.servers.push(
      await transport.server.listen(endpoint, async (request, send) => {
        if (request.kind === "ping")
          return {
            kind: "pong",
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            instanceId: request.instanceId,
            symnavVersion: "test",
          };
        if (request.kind !== "execute") throw new Error("Expected execution");
        await send({
          kind: "accepted",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          acceptedAt: 1,
          queuePosition: 0,
        });
        await delayed;
        return {
          kind: "execution-failed",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "internal",
        };
      }),
    );
    const receipt = await transport.execution.execute(endpoint, harness.request);
    await new Promise((resolve) =>
      setTimeout(resolve, harness.policy.values.transport.singleResponseTimeoutMs + 20),
    );
    await expect(
      transport.lifecycle.request(endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
      }),
    ).resolves.toMatchObject({ kind: "pong" });
    release();
    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
  });

  it.each(["plain", "resume", "failed-ack"])(
    "preserves mixed binary multi-MiB output with %s delivery and capture cleanup",
    async (scenario) => {
      const root = await harness.root();
      const endpoint = join(root, "endpoint");
      const transport = DaemonTransportFactory.create({
        policy: harness.policy,
        captureDirectory: join(root, "captures"),
        ...(scenario === "resume" ? { sockets: new InterruptedFileClient(harness.policy) } : {}),
      });
      const store = new DaemonCompletionSpoolStore({
        directory: join(root, "spool"),
        workspaceKey: "workspace",
        instanceId: "instance",
        policy: harness.policy.values.output,
      });
      const spool = await store.create("request");
      const expected = Buffer.alloc(2 * 1024 * 1024);
      for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251;
      const maximumChunk = harness.policy.values.output.maximumChunkRawBytes;
      let sequence = 0;
      for (let offset = 0; offset < expected.length; offset += maximumChunk)
        await spool.append({
          sequence: sequence++,
          stream: offset % (maximumChunk * 2) === 0 ? "stdout" : "stderr",
          bytes: expected.subarray(offset, offset + maximumChunk),
        });
      const manifest = await spool.finish(7);
      let acknowledged = false;
      let executeCount = 0;
      const resumeOffsets: number[] = [];
      harness.servers.push(
        await transport.server.listen(endpoint, async (request, send) => {
          if (request.kind === "result-ack") {
            if (scenario === "failed-ack") throw new Error("Acknowledgement lost");
            acknowledged = true;
            await spool.dispose();
            return {
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: request.transferId,
            };
          }
          if (request.kind !== "execute" && request.kind !== "result-fetch")
            throw new Error("Expected execution");
          if (request.kind === "execute") executeCount += 1;
          else resumeOffsets.push(request.offset);
          const credentials: Pick<
            DaemonExecuteRequest,
            "instanceId" | "processToken" | "requestId"
          > = {
            instanceId: request.instanceId,
            processToken: request.processToken,
            requestId: request.requestId,
          };
          if (request.kind === "execute")
            await send({ kind: "accepted", ...credentials, acceptedAt: 1, queuePosition: 0 });
          await send({ kind: "result-manifest", ...credentials, manifest });
          let offset = request.kind === "result-fetch" ? request.offset : 0;
          for await (const record of spool.read(offset)) {
            await send({
              ...record,
              transferId: manifest.transferId,
              requestId: request.requestId,
              offset,
            });
            offset += 1;
          }
          await send({
            kind: "result-end",
            ...credentials,
            transferId: manifest.transferId,
            rawBytes: manifest.rawBytes,
            recordCount: manifest.recordCount,
            sha256: manifest.sha256,
          });
        }),
      );
      const receipt = await transport.execution.execute(endpoint, harness.request);
      if (scenario === "failed-ack") {
        await expect(receipt.completion).rejects.toThrow();
        expect(await readdir(join(root, "captures"))).toEqual([]);
        await spool.dispose();
        return;
      }
      const completion = await receipt.completion;
      expect(completion.status).toBe("completed");
      if (completion.status !== "completed") throw new Error("Expected completed result");
      const records = [];
      for await (const record of completion.result.output.records()) records.push(record);
      expect(Buffer.concat(records.map((record) => Buffer.from(record.bytes)))).toEqual(expected);
      expect(records.map((record) => record.stream)).toEqual(
        Array.from({ length: 32 }, (_, index) => (index % 2 === 0 ? "stdout" : "stderr")),
      );
      expect(completion.result.exitCode).toBe(7);
      expect(acknowledged).toBe(true);
      expect(executeCount).toBe(1);
      expect(resumeOffsets).toEqual(scenario === "resume" ? [1] : []);
      expect(await readdir(join(root, "captures"))).toHaveLength(1);
      await completion.result.output.dispose();
      expect(await readdir(join(root, "captures"))).toEqual([]);
    },
    15_000,
  );
});
