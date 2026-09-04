import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import type {
  DaemonActivitySnapshot,
  DaemonExecuteRequest,
  DaemonExecutionServerFrame,
  DaemonLifecycleRequest,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import { DaemonTransportError } from "./daemon-transport-error.js";
import { LocalDaemonTransport as RuntimeLocalDaemonTransport } from "./local-daemon-transport.js";
import { TestLocalDaemonTransport as LocalDaemonTransport } from "../../test/helpers/local-daemon-transport.js";

describe("LocalDaemonTransport validation", () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.length = 0;
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it.each([
    {
      kind: "identify",
      instanceId: "instance",
      processToken: "token",
    },
    pingRequest(),
  ] satisfies readonly DaemonLifecycleRequest[])(
    "uses the status-observer timeout for $kind lifecycle exchanges",
    async (request) => {
      const policy = DaemonPolicyTestFactory.withOverrides(
        DaemonPolicy.fromSystemMemory({ totalBytes: 1024 ** 3 }),
        {
          transport: {
            singleResponseTimeoutMs: 1_000,
            statusResponseTimeoutMs: 10,
          },
        },
      );
      const endpoint = await rawServer(servers, sockets, directories, (socket) => {
        socket.once("data", () => {
          setTimeout(
            () =>
              socket.end(
                frame(
                  request.kind === "identify"
                    ? {
                        kind: "identity",
                        instanceId: request.instanceId,
                        processToken: request.processToken,
                        pid: 123,
                        startedAt: 10,
                      }
                    : {
                        kind: "pong",
                        protocolVersion: DAEMON_PROTOCOL_VERSION,
                        instanceId: request.instanceId,
                        symnavVersion: "test",
                      },
                ),
              ),
            50,
          );
        });
      });
      const transport = new RuntimeLocalDaemonTransport({
        policy,
        lifecycleResponseTimeoutMs: policy.values.transport.statusResponseTimeoutMs,
      });

      await expect(transport.request(endpoint, request)).rejects.toMatchObject({
        code: "timeout",
      });
    },
  );

  it("uses the ordinary timeout for execution-status exchanges", async () => {
    const policy = DaemonPolicyTestFactory.withOverrides(
      DaemonPolicy.fromSystemMemory({ totalBytes: 1024 ** 3 }),
      {
        transport: {
          singleResponseTimeoutMs: 10,
          statusResponseTimeoutMs: 1_000,
        },
      },
    );
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.once("data", () => {
        setTimeout(
          () =>
            socket.end(
              frame({
                kind: "execution-status",
                instanceId: "instance",
                processToken: "token",
                requestId: "request",
                status: { kind: "unknown" },
              }),
            ),
          50,
        );
      });
    });
    const transport = new LocalDaemonTransport(policy.values);

    await expect(
      transport.executionStatus(endpoint, {
        kind: "execution-status",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies connection refusal before request submission", async () => {
    const endpoint = validationEndpoint(directories);

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toMatchObject({
      name: "DaemonTransportError",
      code: "unreachable",
      delivery: "not-submitted",
    } satisfies Partial<DaemonTransportError>);
  });

  it("classifies lifecycle timeout after request submission", async () => {
    const endpoint = await rawServer(servers, sockets, directories, () => undefined);

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 10 }).request(endpoint, pingRequest()),
    ).rejects.toMatchObject({
      code: "timeout",
      delivery: "submitted-unconfirmed",
    } satisfies Partial<DaemonTransportError>);
  });

  it("classifies admission timeout after request submission", async () => {
    const endpoint = await rawServer(servers, sockets, directories, () => undefined);

    await expect(
      new LocalDaemonTransport({ executionRequestTimeoutMs: 10 }).execute(
        endpoint,
        executionRequest(),
      ),
    ).rejects.toMatchObject({
      code: "timeout",
      delivery: "submitted-unconfirmed",
    } satisfies Partial<DaemonTransportError>);
  });

  it.each([
    ["malformed", invalidResponse("malformed")],
    ["truncated", invalidResponse("truncated")],
  ] as const)("classifies %s response framing as corrupt", async (_kind, response) => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.end(response);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toMatchObject({
      code: "corrupt",
      delivery: "submitted-unconfirmed",
    } satisfies Partial<DaemonTransportError>);
  });

  it.each([
    [
      "instance",
      pingRequest(),
      {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "other",
        symnavVersion: "test",
      },
    ],
    [
      "token",
      {
        kind: "identify",
        instanceId: "instance",
        processToken: "expected",
      } satisfies DaemonLifecycleRequest,
      {
        kind: "identity",
        instanceId: "instance",
        processToken: "other",
        pid: 123,
        startedAt: 10,
      },
    ],
  ] as const)("classifies wrong %s as authentication failure", async (_kind, request, response) => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.end(frame(response));
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, request),
    ).rejects.toMatchObject({
      code: "authentication",
      delivery: "accepted",
    } satisfies Partial<DaemonTransportError>);
  });

  it("classifies a correlated protocol mismatch as authenticated incompatibility", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.end(
        frame({
          kind: "pong",
          protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
          instanceId: "instance",
          symnavVersion: "test",
        }),
      );
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toMatchObject({
      code: "incompatible",
      delivery: "accepted",
      authenticatedInstanceId: "instance",
    } satisfies Partial<DaemonTransportError>);
  });

  it("classifies a clean close without a response", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => socket.end());

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toMatchObject({
      code: "closed",
      delivery: "submitted-unconfirmed",
    } satisfies Partial<DaemonTransportError>);
  });

  it("times out a daemon request that never receives a response", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
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
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
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
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
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
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.end(Buffer.concat([prefix, Buffer.from("{}")]));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("truncated frame");
  });

  it("rejects unknown daemon response envelopes", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.write(frame({ kind: "unknown" }));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("Malformed daemon response");
  });

  it.each([
    { transferId: "transfer", requestId: "request", instanceId: "instance", exitCode: 0 },
    {
      transferId: "transfer",
      requestId: "request",
      instanceId: "instance",
      exitCode: 0,
      rawBytes: -1,
      recordCount: 0,
      sha256: "0".repeat(64),
    },
    {
      transferId: "transfer",
      requestId: "other",
      instanceId: "instance",
      exitCode: 0,
      rawBytes: 0,
      recordCount: 0,
      sha256: "invalid",
    },
  ])("rejects malformed daemon result manifests %#", async (manifest) => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.write(
        Buffer.concat([
          frame(acceptedFrame()),
          frame({
            kind: "result-manifest",
            instanceId: "instance",
            processToken: "token",
            requestId: "request",
            manifest,
          }),
        ]),
      );
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 })
        .execute(endpoint, executionRequest())
        .then((receipt) => receipt.completion),
    ).rejects.toThrow("Malformed daemon result manifest");
  });

  it("rejects a response kind for a different request", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.write(
        frame({
          kind: "stopped",
          instanceId: "instance",
        }),
      );
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("Daemon pong does not match request protocol and instance");
  });

  it("rejects multiple daemon responses for one request", async () => {
    const response = frame({
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      symnavVersion: "test",
    });
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.write(Buffer.concat([response, response]));
      setTimeout(() => socket.destroy(), 50);
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("multiple responses");
  });

  it("rejects invalid server requests before invoking the handler", async () => {
    const endpoint = validationEndpoint(directories);
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

  it.each([
    {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "/private/source/PaymentProcessor::charge",
      request: { argv: ["refs", "symbol"], cwd: "/repo", telemetryEnabled: false },
    },
    {
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "/private/source/PaymentProcessor::charge",
    },
    {
      kind: "result-fetch",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "/private/source/PaymentProcessor::charge",
      offset: 0,
    },
    {
      kind: "result-ack",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "/private/source/PaymentProcessor::charge",
      transferId: "transfer",
    },
  ] as const)(
    "rejects source-shaped $kind request correlation before dispatch",
    async (request) => {
      const endpoint = validationEndpoint(directories);
      let handled = false;
      const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });
      const listening = await transport.listen(endpoint, async () => {
        handled = true;
        return { kind: "stopped", instanceId: "instance" };
      });
      const socket = createConnection(endpoint);
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.write(frame(request));
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 20);
        });
      });

      expect(handled).toBe(false);
      await listening.close();
    },
  );

  it("uses native Windows named pipe endpoints", () => {
    expect(validationEndpoint(directories, "win32", "endpoint")).toBe(
      "\\\\.\\pipe\\symnav-transport-validation-endpoint",
    );
    expect(directories).toEqual([]);
  });

  it("rejects malformed daemon pong responses", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
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

  it.each([
    ["busy without current", { lifecycle: "busy" }],
    [
      "ready with current",
      {
        lifecycle: "ready",
        current: { requestId: "request", command: "refs", elapsedMs: 1 },
      },
    ],
    ["recovering without detail", { lifecycle: "recovering" }],
    ["ready with recovery detail", { lifecycle: "ready", recoveryDetail: "resource-pressure" }],
    [
      "path-shaped current command",
      {
        lifecycle: "busy",
        current: { requestId: "request", command: "/private/source.ts", elapsedMs: 1 },
      },
    ],
    [
      "source-shaped current request",
      {
        lifecycle: "busy",
        current: {
          requestId: "/private/source/PaymentProcessor::charge",
          command: "refs",
          elapsedMs: 1,
        },
      },
    ],
    ["starting with indexed files", { lifecycle: "starting", fileCount: 7 }],
  ] as const)("rejects %s activity snapshots", async (_label, contradiction) => {
    const baselineActivity = {
      lifecycle: "ready" as const,
      pid: 123,
      startedAt: 10,
      startupElapsedMs: 20,
      fileCount: 2,
      processRssBytes: 100,
      hardProcessRssBytes: 200,
      workerGeneration: 1,
      queued: 0,
      spoolBytes: 0,
    } satisfies DaemonActivitySnapshot;
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.end(
        frame({
          kind: "pong",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          instanceId: "instance",
          symnavVersion: "test",
          activity: {
            ...baselineActivity,
            ...contradiction,
          },
        }),
      );
    });

    await expect(
      new LocalDaemonTransport({ requestTimeoutMs: 100 }).request(endpoint, pingRequest()),
    ).rejects.toThrow("Malformed daemon pong");
  });

  it("rejects malformed daemon stop responses", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
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
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.write(frame({ kind: "identity", instanceId: "instance", processToken: "process" }));
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
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
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
      const endpoint = await rawServer(servers, sockets, directories, (socket) => {
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
      processToken: "token",
      requestId: "request",
      request: {
        argv: ["--version"],
        cwd: "/workspace",
        telemetryEnabled: false,
        deferTelemetry: "invalid",
      },
    } as unknown as DaemonExecuteRequest;

    expect(() => transport.execute("/missing-daemon-endpoint", request)).toThrow(
      "Malformed daemon execution request",
    );
  });

  it("rejects an unknown caller-supplied daemon command name", async () => {
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });
    const request = {
      ...executionRequest(),
      commandName: "not-a-command",
    } as unknown as DaemonExecuteRequest;

    await expect(
      Promise.resolve().then(() => transport.execute("/missing-daemon-endpoint", request)),
    ).rejects.toThrow("Malformed daemon execution request");
  });

  it("rejects legacy embedded completion results", async () => {
    const endpoint = await rawServer(servers, sockets, directories, (socket) => {
      socket.end(
        Buffer.concat([
          frame(acceptedFrame()),
          frame({
            kind: "completed",
            instanceId: "instance",
            processToken: "token",
            requestId: "request",
            result: { exitCode: 0 },
          }),
        ]),
      );
    });
    const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });

    await expect(
      transport.execute(endpoint, executionRequest()).then((receipt) => receipt.completion),
    ).rejects.toThrow("Malformed daemon response");
  });
});

function pingRequest(): DaemonLifecycleRequest {
  return {
    kind: "ping",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
  };
}

function executionRequest(): DaemonExecuteRequest {
  return {
    kind: "execute",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: "instance",
    processToken: "token",
    requestId: "request",
    commandName: "version",
    request: {
      argv: ["--version"],
      cwd: "/repo",
      telemetryEnabled: false,
      executionMode: "warm",
    },
  };
}

function acceptedFrame(): DaemonExecutionServerFrame {
  return {
    kind: "accepted",
    instanceId: "instance",
    processToken: "token",
    requestId: "request",
    acceptedAt: 1,
    queuePosition: 0,
  };
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

function invalidResponse(scenario: "malformed" | "truncated"): Buffer {
  const prefix = Buffer.alloc(4);
  if (scenario === "truncated") {
    prefix.writeUInt32BE(10);
    return Buffer.concat([prefix, Buffer.from("{}")]);
  }
  prefix.writeUInt32BE(1);
  return Buffer.concat([prefix, Buffer.from("{")]);
}

async function rawServer(
  servers: Server[],
  sockets: Socket[],
  directories: string[],
  connected: (socket: Socket) => void,
): Promise<string> {
  const endpoint = validationEndpoint(directories);
  const server = createServer((socket) => {
    sockets.push(socket);
    connected(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return endpoint;
}

function validationEndpoint(
  directories: string[],
  platform = process.platform,
  uniqueId: string = randomUUID(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\symnav-transport-validation-${uniqueId}`;
  }
  const directory = mkdtempSync(join(tmpdir(), "symnav-transport-validation-"));
  directories.push(directory);
  return join(directory, "daemon.sock");
}
