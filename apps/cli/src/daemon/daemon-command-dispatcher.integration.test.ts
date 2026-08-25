import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import { DaemonCommandDispatcher } from "./daemon-command-dispatcher.js";
import {
  NodeDaemonProcessTerminator,
  type DaemonProcessLauncher,
} from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonRecordObserver } from "./daemon-record-observer.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

const request = {
  argv: ["overview", "input.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
} as const;
const coldResult: CommandExecutionResult = {
  frames: [{ stream: "stdout", bytesBase64: Buffer.from("cold\n").toString("base64") }],
  exitCode: 0,
};

describe("DaemonCommandDispatcher real failure boundaries", () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers.length = 0;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("times out behind a real concurrent startup owner and executes cold once", async () => {
    const runtime = createRuntime(roots);
    const startupLease = runtime.registry.acquireStartup(runtime.identity, "concurrent-owner");
    expect(startupLease).toBeDefined();
    const launcher: DaemonProcessLauncher = {
      symnavVersion: "0.1.0",
      memoryCapBytes: 1024,
      launch: vi.fn(),
    };
    const coordinator = new DaemonStartupCoordinator(
      runtime.registry,
      launcher,
      runtime.transport,
      { startupTimeoutMs: 5, pollIntervalMs: 1 },
    );
    const coldExecute = vi.fn(async () => coldResult);

    await expect(dispatcher(runtime, coordinator, coldExecute).execute(request)).resolves.toEqual({
      mode: "fallback",
      result: coldResult,
    });

    expect(launcher.launch).not.toHaveBeenCalled();
    expect(coldExecute).toHaveBeenCalledTimes(1);
    expect(runtime.registry.read(runtime.identity)).toBeUndefined();
    startupLease?.release();
  });

  it.each(["refused", "malformed", "truncated", "mismatched"] as const)(
    "invalidates a same-version %s endpoint and executes cold once without replacement",
    async (scenario) => {
      const runtime = createRuntime(roots);
      runtime.registry.write(readyRecord(runtime.identity));
      if (scenario !== "refused") {
        const server = createServer((socket) => {
          socket.once("data", () => socket.end(invalidResponse(scenario)));
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(runtime.identity.endpoint("failed"), resolve);
        });
      }
      const ensureRunning = vi.fn();
      const coldExecute = vi.fn(async () => coldResult);

      await expect(
        dispatcher(runtime, { ensureRunning }, coldExecute).execute(request),
      ).resolves.toEqual({ mode: "fallback", result: coldResult });

      expect(ensureRunning).not.toHaveBeenCalled();
      expect(coldExecute).toHaveBeenCalledTimes(1);
      expect(runtime.registry.read(runtime.identity)).toBeUndefined();
    },
  );
});

function createRuntime(roots: string[]) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-dispatch-failure-"));
  roots.push(stateDirectory);
  const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
  const transport = new LocalDaemonTransport({ requestTimeoutMs: 50 });
  const processTerminator = new NodeDaemonProcessTerminator();
  return {
    identity,
    registry: new DaemonRegistry(identity.registryDirectory),
    transport,
    observer: new DaemonRecordObserver(transport, processTerminator),
    stateDirectory,
  };
}

function dispatcher(
  runtime: ReturnType<typeof createRuntime>,
  coordinator: { ensureRunning(identity: DaemonWorkspaceIdentity): Promise<unknown> },
  coldExecute: (request: CliExecutionRequest) => Promise<CommandExecutionResult>,
): DaemonCommandDispatcher {
  return new DaemonCommandDispatcher({
    createDependencies: () =>
      ({
        symnavVersion: "0.1.0",
        recorder: { record: () => {} },
      }) as unknown as ProgramDependencies,
    stateDirectory: runtime.stateDirectory,
    resolveWorkspaceRoot: async () => "/repo",
    runtimeFactory: () => ({ ...runtime, coordinator }),
    executorFactory: () => ({ execute: coldExecute }),
    requestId: () => "expected-request",
  });
}

function readyRecord(identity: DaemonWorkspaceIdentity): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: identity.workspaceRoot,
    workspaceKey: identity.workspaceKey,
    stateKey: identity.stateKey,
    identityKey: identity.identityKey,
    instanceId: "failed",
    processToken: "failed-process",
    endpoint: identity.endpoint("failed"),
    pid: 123,
    state: "ready",
    startedAt: 1,
    readyAt: 2,
    fileCount: 1,
    memoryCapBytes: 1024,
  };
}

function invalidResponse(scenario: "malformed" | "truncated" | "mismatched"): Buffer {
  if (scenario === "truncated") {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(10);
    return Buffer.concat([prefix, Buffer.from("{}")]);
  }
  if (scenario === "mismatched") {
    return frame({
      kind: "result",
      requestId: "different-request",
      result: { frames: [], exitCode: 0 },
    });
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(1);
  return Buffer.concat([prefix, Buffer.from("{")]);
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}
