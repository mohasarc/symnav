import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy, type DaemonExecutionFailureCode } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonExecuteRequest,
  type DaemonExecutionServerFrame,
  type DaemonServerMessage,
} from "./daemon-protocol.js";
import { DaemonTransportError } from "./daemon-transport-error.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "../../test/helpers/local-daemon-transport.js";
import {
  DaemonCompletionSpoolStore as RuntimeDaemonCompletionSpoolStore,
  type DaemonCompletionSpoolStoreOptions,
} from "./completion-spool.js";
import { DaemonWireCodec } from "./daemon-wire-codec.js";
import { DaemonClientResultCapture } from "./daemon-client-result-capture.js";

const TEST_CHUNK_BYTES = 64 * 1024;
const wireCodec = new DaemonWireCodec({
  maximumJsonPayloadBytes: 8 * 1024 * 1024,
  maximumExecutionControlPayloadBytes: 256 * 1024,
  maximumChunkRawBytes: TEST_CHUNK_BYTES,
});

class DaemonCompletionSpoolStore extends RuntimeDaemonCompletionSpoolStore {
  constructor(options: Omit<DaemonCompletionSpoolStoreOptions, "policy">) {
    super({ ...options, policy: DaemonPolicy.currentSystem().values.output });
  }
}

const request: DaemonExecuteRequest = {
  kind: "execute",
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  instanceId: "instance",
  processToken: "token",
  requestId: "request",
  commandName: "overview",
  request: {
    argv: ["overview", "src/a.ts"],
    cwd: "/repo",
    telemetryEnabled: false,
    executionMode: "warm",
  },
};

describe("LocalDaemonTransport execution delivery", () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets) socket.destroy();
    sockets.length = 0;
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("uses the accepted-request protocol generation", () => {
    expect(DAEMON_PROTOCOL_VERSION).toBe(5);
  });

  it("classifies connection refusal before any write as retry-safe", async () => {
    const endpoint = executionEndpoint(directories);

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 25 }).execute(endpoint, request),
    ).rejects.toMatchObject({
      code: "unreachable",
      delivery: "not-submitted",
      retrySafe: true,
    } satisfies Partial<DaemonTransportError>);
  });

  it("classifies a close after submission but before acceptance as non-retryable", async () => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => socket.end());
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).execute(endpoint, request),
    ).rejects.toMatchObject({
      code: "closed",
      delivery: "submitted-unconfirmed",
      retrySafe: false,
    } satisfies Partial<DaemonTransportError>);
  });

  it("preserves authenticated rejection retry safety", async () => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () =>
        socket.end(
          frame({
            kind: "rejected",
            instanceId: request.instanceId,
            processToken: request.processToken,
            requestId: request.requestId,
            code: "not-ready",
            retrySafe: true,
          } satisfies DaemonExecutionServerFrame),
        ),
      );
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).execute(endpoint, request),
    ).rejects.toMatchObject({
      code: "rejected",
      delivery: "submitted-unconfirmed",
      retrySafe: true,
      authenticatedInstanceId: request.instanceId,
    } satisfies Partial<DaemonTransportError>);
  });

  it.each([
    ["not-ready", false],
    ["resource-pressure", false],
    ["draining", false],
    ["incompatible", true],
  ] as const)("rejects contradictory %s retry safety", async (code, retrySafe) => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () =>
        socket.end(
          frame({
            kind: "rejected",
            instanceId: request.instanceId,
            processToken: request.processToken,
            requestId: request.requestId,
            code,
            retrySafe,
          } satisfies DaemonExecutionServerFrame),
        ),
      );
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).execute(endpoint, request),
    ).rejects.toMatchObject({
      code: "corrupt",
      delivery: "submitted-unconfirmed",
      retrySafe: false,
    } satisfies Partial<DaemonTransportError>);
  });

  it("allows execution admission beyond the lifecycle request timeout", async () => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => {
        setTimeout(
          () =>
            socket.end(
              Buffer.concat([
                frame(accepted()),
                frame({
                  kind: "execution-failed",
                  instanceId: request.instanceId,
                  processToken: request.processToken,
                  requestId: request.requestId,
                  code: "internal",
                } satisfies DaemonExecutionServerFrame),
              ]),
            ),
          40,
        );
      });
    });

    const receipt = await new LocalDaemonTransport({ requestTimeoutMs: 10 }).execute(
      endpoint,
      request,
    );

    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
  });

  it("applies the execution admission deadline until acceptance", async () => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => undefined);
    });

    await expect(
      new LocalDaemonTransport(policyWith({ executionAdmissionTimeoutMs: 25 })).execute(
        endpoint,
        request,
      ),
    ).rejects.toMatchObject({
      code: "timeout",
      delivery: "submitted-unconfirmed",
      retrySafe: false,
    } satisfies Partial<DaemonTransportError>);
  });

  it.each<DaemonExecutionFailureCode>([
    "worker-exit",
    "controlled-resource",
    "response-capacity",
    "stopping",
    "internal",
  ])("preserves accepted terminal failure %s without replay", async (code) => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () =>
        socket.end(
          Buffer.concat([
            frame(accepted()),
            frame({
              kind: "execution-failed",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              code,
            } satisfies DaemonExecutionServerFrame),
          ]),
        ),
      );
    });

    const receipt = await new LocalDaemonTransport({ requestTimeoutMs: 100 }).execute(
      endpoint,
      request,
    );

    await expect(receipt.completion).resolves.toEqual({ status: "failed", code });
  });

  it.each([
    ["socket close before acceptance", []],
    ["protocol failure after acceptance", [accepted(), accepted()]],
    [
      "terminal daemon failure",
      [
        accepted(),
        {
          kind: "execution-failed",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "internal",
        } satisfies DaemonExecutionServerFrame,
      ],
    ],
  ] as const)("disposes output exactly once after %s", async (scenario, responses) => {
    const dispose = vi.spyOn(DaemonClientResultCapture.prototype, "dispose");
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => socket.end(Buffer.concat(responses.map(frame))));
    });
    const execution = new LocalDaemonTransport().execute(endpoint, request);

    if (scenario === "socket close before acceptance") {
      await expect(execution).rejects.toMatchObject({
        code: "closed",
        delivery: "submitted-unconfirmed",
      });
    } else {
      const receipt = await execution;
      if (scenario === "terminal daemon failure") {
        await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
      } else {
        await expect(receipt.completion).rejects.toMatchObject({
          code: "corrupt",
          delivery: "accepted",
        });
      }
    }

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("has no completion deadline after acceptance", async () => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => {
        socket.write(frame(accepted()));
        setTimeout(
          () =>
            socket.end(
              frame({
                kind: "execution-failed",
                instanceId: request.instanceId,
                processToken: request.processToken,
                requestId: request.requestId,
                code: "internal",
              } satisfies DaemonExecutionServerFrame),
            ),
          40,
        );
      });
    });

    const receipt = await new LocalDaemonTransport(
      policyWith({ executionAdmissionTimeoutMs: 10 }),
    ).execute(endpoint, request);

    await expect(receipt.completion).resolves.toEqual({
      status: "failed",
      code: "internal",
    });
  });

  it("transfers and acknowledges a generated twelve MiB mixed-stream result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-streamed-result-"));
    directories.push(directory);
    const endpoint = executionEndpoint(directories);
    const store = new DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    const chunkCount = (12 * 1024 * 1024) / TEST_CHUNK_BYTES;
    for (let sequence = 0; sequence < chunkCount; sequence += 1) {
      await spool.append({
        sequence,
        stream: sequence % 2 === 0 ? "stdout" : "stderr",
        bytes: Buffer.alloc(TEST_CHUNK_BYTES, sequence),
      });
    }
    const manifest = await spool.finish(0);
    const serverTransport = new LocalDaemonTransport();
    const server = await serverTransport.listen(endpoint, async (message, send) => {
      if (message.kind === "result-ack") {
        await spool.acknowledge();
        return {
          kind: "result-acknowledged",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          transferId: manifest.transferId,
        };
      }
      if (message.kind !== "execute") throw new Error("Unexpected request");
      send(accepted());
      send({
        kind: "result-manifest",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        manifest,
      });
      for await (const record of spool.read(0)) {
        const chunk: DaemonServerMessage = {
          transferId: manifest.transferId,
          requestId: request.requestId,
          offset: record.sequence,
          sequence: record.sequence,
          stream: record.stream,
          bytes: record.bytes,
        };
        send(chunk);
      }
      send({
        kind: "result-end",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        transferId: manifest.transferId,
        rawBytes: manifest.rawBytes,
        recordCount: manifest.recordCount,
        sha256: manifest.sha256,
      });
    });
    const receipt = await new LocalDaemonTransport().execute(endpoint, request);
    const completion = await receipt.completion;

    expect(completion.status).toBe("completed");
    if (completion.status !== "completed" || completion.result.output === undefined) return;
    expect(completion.result.output).not.toHaveProperty("summary");
    let receivedRecords = 0;
    for await (const record of completion.result.output.records()) {
      expect(record.stream).toBe(receivedRecords % 2 === 0 ? "stdout" : "stderr");
      expect(Buffer.from(record.bytes)).toEqual(Buffer.alloc(TEST_CHUNK_BYTES, receivedRecords));
      receivedRecords += 1;
    }
    expect(receivedRecords).toBe(chunkCount);
    expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
    await completion.result.output.dispose();
    await server.close();
  }, 60_000);

  it("advances one client record only after its spool append completes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-stalled-client-spool-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      await spool.append({
        sequence,
        stream: sequence % 2 === 0 ? "stdout" : "stderr",
        bytes: Buffer.alloc(TEST_CHUNK_BYTES, sequence),
      });
    }
    const manifest = await spool.finish(0);
    let appendCalls = 0;
    let activeAppends = 0;
    let maximumActiveAppends = 0;
    let markAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const append = DaemonClientResultCapture.prototype.append;
    vi.spyOn(DaemonClientResultCapture.prototype, "append").mockImplementation(async function (
      this: DaemonClientResultCapture,
      record,
    ) {
      appendCalls += 1;
      activeAppends += 1;
      maximumActiveAppends = Math.max(maximumActiveAppends, activeAppends);
      markAppendStarted();
      if (appendCalls === 1) await appendGate;
      try {
        await append.call(this, record);
      } finally {
        activeAppends -= 1;
      }
    });
    let acknowledgementCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
        if (message.kind === "execute") {
          void encodedResult(spool, manifest).then((resultBytes) => socket.write(resultBytes));
          return;
        }
        if (message.kind === "result-ack") {
          acknowledgementCount += 1;
          socket.end(
            frame({
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: manifest.transferId,
            }),
          );
        }
      });
    });
    const receipt = await new LocalDaemonTransport({
      outputDirectory: join(directory, "client"),
      outputInlineBytes: 0,
    }).execute(endpoint, request);

    await appendStarted;
    expect(appendCalls).toBe(1);
    expect(maximumActiveAppends).toBe(1);
    expect(acknowledgementCount).toBe(0);
    releaseAppend();
    const completion = await receipt.completion;

    expect(appendCalls).toBe(3);
    expect(maximumActiveAppends).toBe(1);
    expect(acknowledgementCount).toBe(1);
    if (completion.status === "completed") await completion.result.output.dispose();
  });

  it("resumes after a stalled append at the first durably missing record", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-stalled-resume-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      await spool.append({
        sequence,
        stream: sequence % 2 === 0 ? "stdout" : "stderr",
        bytes: Buffer.from(`record-${sequence}`),
      });
    }
    const manifest = await spool.finish(0);
    let markAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const append = DaemonClientResultCapture.prototype.append;
    let appendCalls = 0;
    vi.spyOn(DaemonClientResultCapture.prototype, "append").mockImplementation(async function (
      this: DaemonClientResultCapture,
      record,
    ) {
      appendCalls += 1;
      markAppendStarted();
      if (appendCalls === 1) await appendGate;
      await append.call(this, record);
    });
    const fetchOffsets: number[] = [];
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as {
          kind: string;
          offset?: number;
        };
        if (message.kind === "execute") {
          void firstEncodedRecord(spool, manifest).then((record) =>
            socket.end(Buffer.concat([frame(accepted()), frame(resultManifest(manifest)), record])),
          );
          return;
        }
        if (message.kind === "result-fetch") {
          fetchOffsets.push(message.offset ?? -1);
          socket.write(frame(resultManifest(manifest)));
          void sendRecords(socket, spool, manifest.transferId, message.offset ?? 0).then(() =>
            socket.write(frame(resultEnd(manifest))),
          );
          return;
        }
        if (message.kind === "result-ack") {
          socket.end(
            frame({
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: manifest.transferId,
            }),
          );
        }
      });
    });
    const receipt = await new LocalDaemonTransport().execute(endpoint, request);

    await appendStarted;
    expect(fetchOffsets).toEqual([]);
    releaseAppend();
    const completion = await receipt.completion;

    expect(fetchOffsets).toEqual([1]);
    expect(completion).toMatchObject({ status: "completed", result: { exitCode: 0 } });
    if (completion.status === "completed") await completion.result.output.dispose();
  });

  it("resumes a disconnected result transfer at the contiguous record offset", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-resumed-result-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    for (let sequence = 0; sequence < 5; sequence += 1) {
      await spool.append({
        sequence,
        stream: sequence % 2 === 0 ? "stdout" : "stderr",
        bytes: Buffer.from(`record-${sequence}\n`),
      });
    }
    const manifest = await spool.finish(0);
    const fetchOffsets: number[] = [];
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as {
          kind: string;
          offset?: number;
        };
        if (message.kind === "execute") {
          socket.write(frame(accepted()));
          socket.write(frame(resultManifest(manifest)));
          void sendRecords(socket, spool, manifest.transferId, 0, 2).then(() => socket.end());
          return;
        }
        if (message.kind === "result-fetch") {
          fetchOffsets.push(message.offset ?? -1);
          socket.write(frame(resultManifest(manifest)));
          void sendRecords(socket, spool, manifest.transferId, message.offset ?? 0).then(() =>
            socket.write(frame(resultEnd(manifest))),
          );
          return;
        }
        if (message.kind === "result-ack") {
          void spool.acknowledge().then(() =>
            socket.end(
              frame({
                kind: "result-acknowledged",
                instanceId: request.instanceId,
                processToken: request.processToken,
                requestId: request.requestId,
                transferId: manifest.transferId,
              }),
            ),
          );
        }
      });
    });

    const receipt = await new LocalDaemonTransport().execute(endpoint, request);
    const completion = await receipt.completion;

    expect(fetchOffsets).toEqual([2]);
    expect(completion).toMatchObject({ status: "completed", result: { exitCode: 0 } });
    if (completion.status === "completed") {
      expect(completion.result.output).not.toHaveProperty("summary");
      const records = [];
      for await (const record of completion.result.output.records()) {
        records.push({ stream: record.stream, bytes: Buffer.from(record.bytes).toString() });
      }
      expect(records).toEqual(
        Array.from({ length: 5 }, (_, sequence) => ({
          stream: sequence % 2 === 0 ? "stdout" : "stderr",
          bytes: `record-${sequence}\n`,
        })),
      );
    }
    expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
    if (completion.status === "completed") await completion.result.output?.dispose();
  });

  it("disables result fetch resume without disabling execution reattachment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-zero-result-resume-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    const manifest = await spool.finish(0);
    let executeCount = 0;
    let fetchCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
        if (message.kind === "result-fetch") {
          fetchCount += 1;
          return;
        }
        executeCount += 1;
        if (executeCount === 1) {
          socket.end(Buffer.concat([frame(accepted()), frame(resultManifest(manifest))]));
          return;
        }
        socket.end(
          Buffer.concat([
            frame(accepted()),
            frame({
              kind: "execution-failed",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              code: "internal",
            } satisfies DaemonExecutionServerFrame),
          ]),
        );
      });
    });

    const receipt = await new LocalDaemonTransport(
      policyWith({}, { resultTransferResumeLimitPerExecutionAttempt: 0 }),
    ).execute(endpoint, request);

    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
    expect({ executeCount, fetchCount }).toEqual({ executeCount: 2, fetchCount: 0 });
  });

  it("honors result fetch resume limits greater than one within one execute attempt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-multiple-result-resumes-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    const manifest = await spool.finish(0);
    let executeCount = 0;
    const fetchOffsets: number[] = [];
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as {
          kind: string;
          offset?: number;
        };
        if (message.kind === "result-ack") {
          socket.end(
            frame({
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: manifest.transferId,
            }),
          );
          return;
        }
        if (message.kind === "result-fetch") {
          fetchOffsets.push(message.offset ?? -1);
          if (fetchOffsets.length === 1) {
            socket.end(frame(resultManifest(manifest)));
            return;
          }
          socket.end(Buffer.concat([frame(resultManifest(manifest)), frame(resultEnd(manifest))]));
          return;
        }
        executeCount += 1;
        socket.end(Buffer.concat([frame(accepted()), frame(resultManifest(manifest))]));
      });
    });

    const receipt = await new LocalDaemonTransport(
      policyWith(
        {},
        {
          postAcceptanceExecutionReattachmentLimit: 0,
          resultTransferResumeLimitPerExecutionAttempt: 2,
        },
      ),
    ).execute(endpoint, request);
    const completion = await receipt.completion;

    expect({ executeCount, fetchOffsets }).toEqual({ executeCount: 1, fetchOffsets: [0, 0] });
    expect(completion).toMatchObject({ status: "completed", result: { exitCode: 0 } });
    if (completion.status === "completed") await completion.result.output.dispose();
  });

  it.each([
    "duplicate-manifest",
    "missing-manifest",
    "wrong-transfer",
    "wrong-raw-bytes",
    "wrong-record-count",
    "wrong-digest",
    "duplicate-end",
    "chunk-after-end",
  ] as const)("rejects corrupt resumed transfer control: %s", async (corruption) => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-corrupt-resume-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    for (let sequence = 0; sequence < 4; sequence += 1) {
      await spool.append({
        sequence,
        stream: sequence % 2 === 0 ? "stdout" : "stderr",
        bytes: Buffer.alloc(TEST_CHUNK_BYTES, sequence),
      });
    }
    const manifest = await spool.finish(0);
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
        if (message.kind === "execute") {
          socket.write(frame(accepted()));
          socket.write(frame(resultManifest(manifest)));
          void sendRecords(socket, spool, manifest.transferId, 0, 2).then(() => socket.end());
          return;
        }
        if (message.kind === "result-ack") {
          socket.end(
            frame({
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: manifest.transferId,
            }),
          );
          return;
        }
        if (message.kind !== "result-fetch") return;
        if (corruption !== "missing-manifest") socket.write(frame(resultManifest(manifest)));
        if (corruption === "duplicate-manifest") socket.write(frame(resultManifest(manifest)));
        void sendRecords(socket, spool, manifest.transferId, 2).then(() => {
          const end = {
            ...resultEnd(manifest),
            ...(corruption === "wrong-transfer" ? { transferId: "other-transfer" } : {}),
            ...(corruption === "wrong-raw-bytes" ? { rawBytes: manifest.rawBytes + 1 } : {}),
            ...(corruption === "wrong-record-count"
              ? { recordCount: manifest.recordCount + 1 }
              : {}),
            ...(corruption === "wrong-digest" ? { sha256: "0".repeat(64) } : {}),
          } satisfies Extract<DaemonExecutionServerFrame, { kind: "result-end" }>;
          const encodedEnd = frame(end);
          if (corruption === "duplicate-end") {
            socket.write(Buffer.concat([encodedEnd, encodedEnd]));
          } else if (corruption === "chunk-after-end") {
            socket.write(
              Buffer.concat([
                encodedEnd,
                wireCodec.encodeServerMessage({
                  transferId: manifest.transferId,
                  requestId: request.requestId,
                  offset: manifest.recordCount,
                  sequence: manifest.recordCount,
                  stream: "stdout",
                  bytes: Buffer.from("late"),
                }),
              ]),
            );
          } else {
            socket.write(encodedEnd);
          }
        });
      });
    });
    const clientDirectory = join(directory, "client");
    const receipt = await new LocalDaemonTransport({
      outputDirectory: clientDirectory,
      outputInlineBytes: 0,
    }).execute(endpoint, request);

    await expect(receipt.completion).rejects.toMatchObject({
      code: "corrupt",
      delivery: "accepted",
      retrySafe: false,
    } satisfies Partial<DaemonTransportError>);
    expect(store.usage()).toEqual({
      rawBytes: manifest.rawBytes,
      completionCount: 1,
    });
    expect(
      await import("node:fs/promises").then(({ readdir }) => readdir(clientDirectory)),
    ).toEqual([]);
  });

  it.each(["eof", "close", "malformed", "multiple", "multiple-separated"] as const)(
    "settles an accepted completion when the acknowledgement response is %s",
    async (acknowledgementFailure) => {
      const directory = mkdtempSync(join(tmpdir(), "symnav-result-acknowledgement-"));
      directories.push(directory);
      const store = new DaemonCompletionSpoolStore({
        directory: join(directory, "daemon"),
        workspaceKey: "workspace",
        instanceId: request.instanceId,
      });
      const spool = await store.create(request.requestId);
      await spool.append({
        sequence: 0,
        stream: "stdout",
        bytes: Buffer.alloc(TEST_CHUNK_BYTES, 7),
      });
      await spool.append({
        sequence: 1,
        stream: "stderr",
        bytes: Buffer.from("spill"),
      });
      const manifest = await spool.finish(0);
      const acknowledgement = frame({
        kind: "result-acknowledged",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        transferId: manifest.transferId,
      });
      const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
        socket.once("data", (encoded) => {
          const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
          const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
          if (message.kind === "execute") {
            socket.write(frame(accepted()));
            socket.write(frame(resultManifest(manifest)));
            void sendRecords(socket, spool, manifest.transferId, 0).then(() =>
              socket.write(frame(resultEnd(manifest))),
            );
            return;
          }
          if (message.kind !== "result-ack") return;
          void spool.acknowledge().then(() => {
            if (acknowledgementFailure === "eof") socket.end();
            else if (acknowledgementFailure === "close") socket.destroy();
            else if (acknowledgementFailure === "malformed") {
              socket.end(Buffer.from([0, 0, 0, 4, 0x7b]));
            } else if (acknowledgementFailure === "multiple") {
              socket.end(Buffer.concat([acknowledgement, acknowledgement]));
            } else {
              socket.write(acknowledgement);
              setImmediate(() => socket.end(acknowledgement));
            }
          });
        });
      });
      const clientDirectory = join(directory, "client");
      const receipt = await new LocalDaemonTransport({
        requestTimeoutMs: 100,
        outputDirectory: clientDirectory,
        outputInlineBytes: 0,
      }).execute(endpoint, request);

      await expect(settleWithin(receipt.completion, 500)).rejects.toMatchObject({
        delivery: "accepted",
        retrySafe: false,
      } satisfies Partial<DaemonTransportError>);
      expect(store.usage()).toEqual({ rawBytes: 0, completionCount: 0 });
      expect(
        await import("node:fs/promises").then(({ readdir }) => readdir(clientDirectory)),
      ).toEqual([]);
    },
  );

  it("cleans client output and fails without replay when the daemon dies before resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-dead-resume-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    for (let sequence = 0; sequence < 4; sequence += 1) {
      await spool.append({
        sequence,
        stream: sequence % 2 === 0 ? "stdout" : "stderr",
        bytes: Buffer.alloc(TEST_CHUNK_BYTES, sequence),
      });
    }
    const manifest = await spool.finish(0);
    const endpoint = executionEndpoint(directories);
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.once("data", () => {
        socket.write(frame(accepted()));
        socket.write(frame(resultManifest(manifest)));
        void sendRecords(socket, spool, manifest.transferId, 0, 2).then(() => {
          server.close();
          socket.end();
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    const clientDirectory = join(directory, "client");
    const receipt = await new LocalDaemonTransport({
      requestTimeoutMs: 100,
      outputDirectory: clientDirectory,
      outputInlineBytes: 0,
    }).execute(endpoint, request);

    await expect(receipt.completion).rejects.toMatchObject({
      code: "closed",
      delivery: "accepted",
      retrySafe: false,
    });
    expect(
      await import("node:fs/promises").then(({ readdir }) => readdir(clientDirectory)),
    ).toEqual([]);
  });

  it("disposes partial client output when daemon delivery fails after its manifest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-failed-delivery-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    await spool.append({
      sequence: 0,
      stream: "stdout",
      bytes: Buffer.alloc(TEST_CHUNK_BYTES, 3),
    });
    await spool.append({
      sequence: 1,
      stream: "stderr",
      bytes: Buffer.from("spill"),
    });
    const manifest = await spool.finish(0);
    let acknowledgementCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
        if (message.kind === "result-ack") {
          acknowledgementCount += 1;
          return;
        }
        socket.write(frame(accepted()));
        socket.write(frame(resultManifest(manifest)));
        void sendRecords(socket, spool, manifest.transferId, 0).then(() =>
          socket.write(
            frame({
              kind: "execution-failed",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              code: "internal",
            }),
          ),
        );
      });
    });
    const clientDirectory = join(directory, "client");
    const receipt = await new LocalDaemonTransport({
      outputDirectory: clientDirectory,
      outputInlineBytes: 0,
    }).execute(endpoint, request);

    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
    expect(acknowledgementCount).toBe(0);
    expect(
      await import("node:fs/promises").then(({ readdir }) => readdir(clientDirectory)),
    ).toEqual([]);
  });

  it("reports EOF after acceptance as a typed post-accept failure", async () => {
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => socket.end(frame(accepted())));
    });

    const receipt = await new LocalDaemonTransport({ requestTimeoutMs: 100 }).execute(
      endpoint,
      request,
    );

    await expect(receipt.completion).rejects.toMatchObject({
      code: "closed",
      delivery: "accepted",
      retrySafe: false,
      authenticatedInstanceId: request.instanceId,
    } satisfies Partial<DaemonTransportError>);
  });

  it("disables accepted execution reattachment without disabling fetch policy", async () => {
    let executeCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => {
        executeCount += 1;
        socket.end(frame(accepted()));
      });
    });

    const receipt = await new LocalDaemonTransport(
      policyWith({}, { postAcceptanceExecutionReattachmentLimit: 0 }),
    ).execute(endpoint, request);

    await expect(receipt.completion).rejects.toMatchObject({
      code: "closed",
      delivery: "accepted",
      authenticatedInstanceId: request.instanceId,
    } satisfies Partial<DaemonTransportError>);
    expect(executeCount).toBe(1);
  });

  it("honors accepted execution reattachment limits greater than one", async () => {
    let executeCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => {
        executeCount += 1;
        if (executeCount < 3) {
          socket.end(frame(accepted()));
          return;
        }
        socket.end(
          Buffer.concat([
            frame(accepted()),
            frame({
              kind: "execution-failed",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              code: "internal",
            } satisfies DaemonExecutionServerFrame),
          ]),
        );
      });
    });

    const receipt = await new LocalDaemonTransport(
      policyWith({}, { postAcceptanceExecutionReattachmentLimit: 2 }),
    ).execute(endpoint, request);

    await expect(receipt.completion).resolves.toEqual({ status: "failed", code: "internal" });
    expect(executeCount).toBe(3);
  });

  it("rethrows the first accepted close when reattachment fails before acceptance", async () => {
    let executeCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => {
        executeCount += 1;
        if (executeCount === 1) socket.end(frame(accepted()));
        else socket.end();
      });
    });

    const receipt = await new LocalDaemonTransport(
      policyWith({}, { postAcceptanceExecutionReattachmentLimit: 1 }),
    ).execute(endpoint, request);

    await expect(receipt.completion).rejects.toMatchObject({
      code: "closed",
      delivery: "accepted",
      message: "Daemon connection ended after acceptance before completion",
      authenticatedInstanceId: request.instanceId,
    } satisfies Partial<DaemonTransportError>);
    expect(executeCount).toBe(2);
  });

  it("reattaches once with the same request after accepted delivery closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-accepted-reattach-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    const manifest = await spool.finish(0);
    let executeCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
        if (message.kind === "result-ack") {
          socket.end(
            frame({
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: manifest.transferId,
            }),
          );
          return;
        }
        executeCount += 1;
        if (executeCount === 1) {
          socket.end(frame(accepted()));
          return;
        }
        socket.end(
          Buffer.concat([
            frame(accepted()),
            frame(resultManifest(manifest)),
            frame(resultEnd(manifest)),
          ]),
        );
      });
    });

    const receipt = await new LocalDaemonTransport({ requestTimeoutMs: 100 }).execute(
      endpoint,
      request,
    );

    const completion = await receipt.completion;

    expect(completion).toMatchObject({ status: "completed", result: { exitCode: 0 } });
    expect(executeCount).toBe(2);
    if (completion.status === "completed") await completion.result.output.dispose();
  });

  it("reattaches the same request with fresh output and disposes the interrupted capture once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-isolated-reattach-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    await spool.append({
      sequence: 0,
      stream: "stdout",
      bytes: Buffer.from("partial"),
    });
    const manifest = await spool.finish(0);
    const executeRequests: unknown[] = [];
    const dispose = vi.spyOn(DaemonClientResultCapture.prototype, "dispose");
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
        if (message.kind === "result-ack") {
          socket.end(
            frame({
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: manifest.transferId,
            }),
          );
          return;
        }
        executeRequests.push(message);
        if (executeRequests.length === 1) {
          void firstEncodedRecord(spool, manifest).then((record) =>
            socket.end(Buffer.concat([frame(accepted()), frame(resultManifest(manifest)), record])),
          );
          return;
        }
        void encodedResult(spool, manifest).then((result) => socket.end(result));
      });
    });

    const receipt = await new LocalDaemonTransport(
      policyWith({}, { resultTransferResumeLimitPerExecutionAttempt: 0 }),
    ).execute(endpoint, request);
    const completion = await receipt.completion;

    expect(executeRequests).toEqual([request, request]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(completion).toMatchObject({ status: "completed", result: { exitCode: 0 } });
    if (completion.status === "completed") await completion.result.output.dispose();
  });

  it("gives the reattached execute attempt its own fetch resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symnav-reattach-resume-"));
    directories.push(directory);
    const store = new DaemonCompletionSpoolStore({
      directory: join(directory, "daemon"),
      workspaceKey: "workspace",
      instanceId: request.instanceId,
    });
    const spool = await store.create(request.requestId);
    const manifest = await spool.finish(0);
    let executeCount = 0;
    let fetchCount = 0;
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", (encoded) => {
        const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
        const message = JSON.parse(bytes.subarray(4).toString()) as { kind: string };
        if (message.kind === "result-ack") {
          socket.end(
            frame({
              kind: "result-acknowledged",
              instanceId: request.instanceId,
              processToken: request.processToken,
              requestId: request.requestId,
              transferId: manifest.transferId,
            }),
          );
          return;
        }
        if (message.kind === "result-fetch") {
          fetchCount += 1;
          socket.end(Buffer.concat([frame(resultManifest(manifest)), frame(resultEnd(manifest))]));
          return;
        }
        executeCount += 1;
        socket.end(
          executeCount === 1
            ? frame(accepted())
            : Buffer.concat([frame(accepted()), frame(resultManifest(manifest))]),
        );
      });
    });

    const receipt = await new LocalDaemonTransport().execute(endpoint, request);
    const completion = await receipt.completion;

    expect(completion).toMatchObject({ status: "completed", result: { exitCode: 0 } });
    expect({ executeCount, fetchCount }).toEqual({ executeCount: 2, fetchCount: 1 });
    if (completion.status === "completed") await completion.result.output.dispose();
  });

  it.each([
    ["instance", { ...accepted(), instanceId: "other" }],
    ["token", { ...accepted(), processToken: "other" }],
    ["request identifier", { ...accepted(), requestId: "other" }],
    [
      "completion before acceptance",
      {
        kind: "execution-failed",
        instanceId: request.instanceId,
        processToken: request.processToken,
        requestId: request.requestId,
        code: "internal",
      },
    ],
    ["duplicate acceptance", [accepted(), accepted()]],
    [
      "duplicate terminal frame",
      [
        accepted(),
        {
          kind: "execution-failed",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "internal",
        },
        {
          kind: "execution-failed",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "internal",
        },
      ],
    ],
    [
      "unknown failure code",
      [
        accepted(),
        {
          kind: "execution-failed",
          instanceId: request.instanceId,
          processToken: request.processToken,
          requestId: request.requestId,
          code: "unknown",
        },
      ],
    ],
  ])("rejects invalid execution frame sequence: %s", async (_name, response) => {
    const frames = Array.isArray(response) ? response : [response];
    const endpoint = await rawExecutionServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => socket.end(Buffer.concat(frames.map(frame))));
    });
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });

    const execution = transport.execute(endpoint, request);
    await expect(execution.then((receipt) => receipt.completion)).rejects.toMatchObject({
      code: expect.stringMatching(/authentication|corrupt/),
      retrySafe: false,
    });
  });
});

function accepted(): DaemonExecutionServerFrame {
  return {
    kind: "accepted",
    instanceId: request.instanceId,
    processToken: request.processToken,
    requestId: request.requestId,
    acceptedAt: 10,
    queuePosition: 0,
  };
}

function resultManifest(
  manifest: import("./completion-spool.js").CompletionSpoolManifest,
): DaemonExecutionServerFrame {
  return {
    kind: "result-manifest",
    instanceId: request.instanceId,
    processToken: request.processToken,
    requestId: request.requestId,
    manifest,
  };
}

function resultEnd(
  manifest: import("./completion-spool.js").CompletionSpoolManifest,
): Extract<DaemonExecutionServerFrame, { kind: "result-end" }> {
  return {
    kind: "result-end",
    instanceId: request.instanceId,
    processToken: request.processToken,
    requestId: request.requestId,
    transferId: manifest.transferId,
    rawBytes: manifest.rawBytes,
    recordCount: manifest.recordCount,
    sha256: manifest.sha256,
  };
}

async function sendRecords(
  socket: Socket,
  spool: import("./completion-spool.js").CompletionSpool,
  transferId: string,
  offset: number,
  stopBefore = Number.POSITIVE_INFINITY,
): Promise<void> {
  for await (const record of spool.read(offset)) {
    if (record.sequence >= stopBefore || socket.destroyed || !socket.writable) return;
    socket.write(
      wireCodec.encodeServerMessage({
        transferId,
        requestId: request.requestId,
        offset: record.sequence,
        sequence: record.sequence,
        stream: record.stream,
        bytes: record.bytes,
      }),
    );
  }
}

async function encodedResult(
  spool: import("./completion-spool.js").CompletionSpool,
  manifest: import("./completion-spool.js").CompletionSpoolManifest,
): Promise<Buffer> {
  const chunks = [frame(accepted()), frame(resultManifest(manifest))];
  for await (const record of spool.read(0)) {
    chunks.push(
      Buffer.from(
        wireCodec.encodeServerMessage({
          transferId: manifest.transferId,
          requestId: request.requestId,
          offset: record.sequence,
          sequence: record.sequence,
          stream: record.stream,
          bytes: record.bytes,
        }),
      ),
    );
  }
  chunks.push(frame(resultEnd(manifest)));
  return Buffer.concat(chunks);
}

async function firstEncodedRecord(
  spool: import("./completion-spool.js").CompletionSpool,
  manifest: import("./completion-spool.js").CompletionSpoolManifest,
): Promise<Buffer> {
  for await (const record of spool.read(0)) {
    return Buffer.from(
      wireCodec.encodeServerMessage({
        transferId: manifest.transferId,
        requestId: request.requestId,
        offset: record.sequence,
        sequence: record.sequence,
        stream: record.stream,
        bytes: record.bytes,
      }),
    );
  }
  throw new Error("Expected one completion record");
}

async function rawExecutionServer(
  servers: Server[],
  sockets: Socket[],
  directories: string[],
  connected: (socket: Socket) => void,
): Promise<string> {
  const endpoint = executionEndpoint(directories);
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return;
      throw error;
    });
    connected(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return endpoint;
}

function executionEndpoint(directories: string[]): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\symnav-execution-${randomUUID()}`;
  }
  const directory = mkdtempSync(join(tmpdir(), "symnav-execution-"));
  directories.push(directory);
  return join(directory, "daemon.sock");
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

async function settleWithin<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Operation did not settle")), milliseconds);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function policyWith(
  transport: { readonly executionAdmissionTimeoutMs?: number } = {},
  delivery: {
    readonly postAcceptanceExecutionReattachmentLimit?: number;
    readonly resultTransferResumeLimitPerExecutionAttempt?: number;
  } = {},
) {
  return DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
    transport,
    delivery,
  }).values;
}
