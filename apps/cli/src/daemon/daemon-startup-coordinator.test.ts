import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import {
  NodeDaemonProcessTerminator,
  type DaemonProcess,
  type DaemonProcessLauncher,
  type DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("DaemonStartupCoordinator", () => {
  const roots: string[] = [];
  const realProcessIds: number[] = [];

  afterEach(async () => {
    const terminator = new NodeDaemonProcessTerminator(100, 5);
    for (const pid of realProcessIds) {
      if (terminator.isAlive(pid)) await terminator.terminate(pid);
    }
    realProcessIds.length = 0;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("concurrent starts launch one daemon and report ready then already running", async () => {
    const harness = new CoordinatorHarness(roots);

    const [first, second] = await Promise.all([
      harness.coordinator().ensureRunning(harness.identity),
      harness.coordinator().ensureRunning(harness.identity),
    ]);

    expect(harness.launcher.launchCount).toBe(1);
    expect([first.status, second.status].sort()).toEqual(["already-running", "ready"]);
    expect(harness.registry.list()).toHaveLength(1);
  });

  it("reuses a validated daemon running the same version", async () => {
    const harness = new CoordinatorHarness(roots);
    harness.seedReady("existing", "0.1.0", 4001);

    const result = await harness.coordinator().ensureRunning(harness.identity);

    expect(result.status).toBe("already-running");
    expect(harness.launcher.launchCount).toBe(0);
  });

  it("drains a validated daemon running a different version", async () => {
    const harness = new CoordinatorHarness(roots);
    harness.seedReady("existing", "0.0.9", 4002);

    const result = await harness.coordinator().ensureRunning(harness.identity);

    expect(harness.transport.terminationCount).toBe(1);
    expect(harness.terminator.terminated).not.toContain(4002);
    expect(harness.launcher.launchCount).toBe(1);
    expect(result.status).toBe("ready");
    expect(harness.registry.list()).toHaveLength(1);
  });

  it("does not terminate an unrelated live process referenced by a stale record", async () => {
    const oldPid = await spawnIdleProcess(realProcessIds);
    const runtime = socketBackedCoordinator(roots);
    runtime.registry.write(readyRecord(runtime.identity, "old", "old-process", oldPid));

    const result = await runtime.coordinator.ensureRunning(runtime.identity);

    expect(result.status).toBe("ready");
    expect(runtime.terminator.isAlive(oldPid)).toBe(true);
    expect(runtime.registry.list()).toHaveLength(1);
    await runtime.launcher.close();
  });

  it.each(["schema", "protocol", "symnav"] as const)(
    "proves and replaces a real daemon for $mismatch mismatch",
    async (mismatch) => {
      const runtime = socketBackedCoordinator(roots);
      const oldPid = await spawnIdentifiableDaemon(
        runtime.identity,
        "old",
        "old-process",
        10,
        realProcessIds,
      );
      const oldRecord = readyRecord(runtime.identity, "old", "old-process", oldPid);
      const incompatibleRecord: DaemonRecord = {
        ...oldRecord,
        schemaVersion:
          mismatch === "schema" ? DAEMON_RECORD_SCHEMA_VERSION + 1 : oldRecord.schemaVersion,
        protocolVersion:
          mismatch === "protocol" ? DAEMON_PROTOCOL_VERSION + 1 : oldRecord.protocolVersion,
        symnavVersion: mismatch === "symnav" ? "0.0.9" : "0.1.0",
      };
      runtime.registry.write(incompatibleRecord);

      const result = await runtime.coordinator.ensureRunning(runtime.identity);

      expect(result.status).toBe("ready");
      await waitUntil(() => !runtime.terminator.isAlive(oldPid));
      expect(runtime.registry.list()).toHaveLength(1);
      expect(runtime.registry.read(runtime.identity)?.instanceId).not.toBe("old");
      await runtime.launcher.close();
    },
  );

});

interface CoordinatorHarnessOptions {
  readonly launchFailure?: Error;
  readonly neverReady?: boolean;
  readonly newDaemonPid?: number;
}

class CoordinatorHarness {
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly terminator = new TestProcessTerminator();
  readonly launcher: ReadyTestLauncher;
  readonly transport: RegistryTransport;

  constructor(roots: string[], options: CoordinatorHarnessOptions = {}) {
    const stateDir = temporaryDirectory(roots);
    this.identity = DaemonWorkspaceIdentity.from("/repo", stateDir);
    this.registry = new DaemonRegistry(this.identity.registryDirectory);
    this.launcher = new ReadyTestLauncher(this.registry, this.identity, this.terminator, options);
    this.transport = new RegistryTransport(this.registry, this.identity);
  }

  coordinator(
    options: {
      readonly startupTimeoutMs?: number;
      readonly processTerminator?: DaemonProcessTerminator;
    } = {},
  ): DaemonStartupCoordinator {
    return new DaemonStartupCoordinator(
      this.registry,
      this.launcher,
      this.transport as unknown as LocalDaemonTransport,
      {
        ...(options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: options.startupTimeoutMs }),
        pollIntervalMs: 1,
        processTerminator: options.processTerminator ?? this.terminator,
      },
    );
  }

  seedReady(instanceId: string, symnavVersion: string, pid: number): void {
    this.terminator.alive.add(pid);
    this.registry.write(this.readyRecord(instanceId, symnavVersion, pid));
  }

  readyRecord(instanceId: string, symnavVersion: string, pid: number): DaemonRecord {
    return {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion,
      workspaceRoot: this.identity.workspaceRoot,
      workspaceKey: this.identity.workspaceKey,
      instanceId,
      processToken: `${instanceId}-process`,
      endpoint: this.identity.endpoint(instanceId),
      pid,
      state: "ready",
      startedAt: 10,
      readyAt: 20,
      fileCount: 2,
      memoryCapBytes: 256 * 1024 * 1024,
    };
  }
}

class ReadyTestLauncher implements DaemonProcessLauncher {
  readonly symnavVersion = "0.1.0";
  readonly memoryCapBytes = 256 * 1024 * 1024;
  launchCount = 0;
  lastPid = 0;
  private nextPid = 5000;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly terminator: TestProcessTerminator,
    private readonly options: CoordinatorHarnessOptions,
  ) {}

  async launch(_identity: DaemonWorkspaceIdentity, instanceId: string): Promise<DaemonProcess> {
    this.launchCount += 1;
    if (this.options.launchFailure) throw this.options.launchFailure;
    const pid = this.options.newDaemonPid ?? this.nextPid++;
    this.lastPid = pid;
    this.terminator.alive.add(pid);
    if (!this.options.neverReady) {
      setTimeout(() => {
        const starting = this.registry.readInstance(this.identity, instanceId);
        if (starting?.state !== "starting") return;
        this.registry.writeIfStartupOwner(this.identity, {
          ...starting,
          state: "ready",
          readyAt: Date.now(),
          fileCount: 2,
        });
      }, 0);
    }
    return {
      pid,
      terminate: () => this.terminator.terminate(pid),
    };
  }
}

class RegistryTransport {
  terminationCount = 0;
  private readonly terminatedInstances = new Set<string>();

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
  ) {}

  async request(_endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    if (request.kind === "stop") {
      return { kind: "stopped", instanceId: request.instanceId };
    }
    if (request.kind === "terminate") {
      this.terminationCount += 1;
      this.terminatedInstances.add(request.instanceId);
      return {
        kind: "terminating",
        instanceId: request.instanceId,
        processToken: request.processToken,
      };
    }
    if (request.kind === "identify") {
      if (this.terminatedInstances.has(request.instanceId)) throw new Error("daemon terminated");
      const record = this.registry.readStoredInstance(this.identity, request.instanceId);
      if (record === undefined) throw new Error("missing daemon");
      return {
        kind: "identity",
        instanceId: record.instanceId,
        processToken: record.processToken,
        pid: record.pid,
        startedAt: record.startedAt,
      };
    }
    if (request.kind === "execute") {
      return {
        kind: "result",
        requestId: request.requestId,
        result: { frames: [], exitCode: 0 },
      };
    }
    const record = this.registry.readStoredInstance(this.identity, request.instanceId);
    if (record === undefined) throw new Error("missing daemon");
    return {
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: request.instanceId,
      symnavVersion: record.symnavVersion,
    };
  }
}

class TestProcessTerminator implements DaemonProcessTerminator {
  readonly alive = new Set<number>();
  readonly terminated: number[] = [];

  isAlive(pid: number): boolean {
    return pid === process.pid || this.alive.has(pid);
  }

  async terminate(pid: number): Promise<void> {
    this.terminated.push(pid);
    this.alive.delete(pid);
  }
}

function temporaryDirectory(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-startup-"));
  roots.push(root);
  return root;
}
function spawnIdleProcess(processIds: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      processIds.push(child.pid!);
      resolve(child.pid!);
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for daemon process exit");
}

interface SocketBackedCoordinator {
  readonly identity: DaemonWorkspaceIdentity;
  readonly registry: DaemonRegistry;
  readonly terminator: NodeDaemonProcessTerminator;
  readonly launcher: InProcessReadyLauncher;
  readonly coordinator: DaemonStartupCoordinator;
}

function socketBackedCoordinator(roots: string[]): SocketBackedCoordinator {
  const stateDirectory = temporaryDirectory(roots);
  const identity = DaemonWorkspaceIdentity.from(join(stateDirectory, "workspace"), stateDirectory);
  const registry = new DaemonRegistry(identity.registryDirectory);
  const transport = new LocalDaemonTransport({ requestTimeoutMs: 100 });
  const terminator = new NodeDaemonProcessTerminator(100, 5);
  const launcher = new InProcessReadyLauncher(registry, transport);
  return {
    identity,
    registry,
    terminator,
    launcher,
    coordinator: new DaemonStartupCoordinator(registry, launcher, transport, {
      startupTimeoutMs: 1_000,
      pollIntervalMs: 2,
      processTerminator: terminator,
    }),
  };
}

class InProcessReadyLauncher implements DaemonProcessLauncher {
  readonly symnavVersion = "0.1.0";
  readonly memoryCapBytes = 256 * 1024 * 1024;
  private server: Awaited<ReturnType<LocalDaemonTransport["listen"]>> | undefined;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: LocalDaemonTransport,
  ) {}

  async launch(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): Promise<DaemonProcess> {
    const startingRecord = this.registry.readInstance(identity, instanceId);
    if (startingRecord?.state !== "starting") throw new Error("missing starting record");
    this.server = await this.transport.listen(identity.endpoint(instanceId), async (request) => {
      if (request.kind === "identify") {
        return {
          kind: "identity",
          instanceId,
          processToken,
          pid: process.pid,
          startedAt: startingRecord.startedAt,
        };
      }
      if (request.kind === "terminate") {
        setTimeout(() => void this.close(), 0);
        return { kind: "terminating", instanceId, processToken };
      }
      if (request.kind === "ping") {
        return {
          kind: "pong",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          instanceId,
          symnavVersion: this.symnavVersion,
        };
      }
      if (request.kind === "execute") {
        return {
          kind: "result",
          requestId: request.requestId,
          result: { frames: [], exitCode: 0 },
        };
      }
      return { kind: "stopped", instanceId };
    });
    setTimeout(() => {
      const record = this.registry.readInstance(identity, instanceId);
      if (record?.state !== "starting") return;
      this.registry.writeIfStartupOwner(identity, {
        ...record,
        state: "ready",
        readyAt: Date.now(),
        fileCount: 2,
      });
    }, 0);
    return { pid: process.pid, terminate: () => this.close() };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.close();
  }
}

function readyRecord(
  identity: DaemonWorkspaceIdentity,
  instanceId: string,
  processToken: string,
  pid: number,
): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: identity.workspaceRoot,
    workspaceKey: identity.workspaceKey,
    instanceId,
    processToken,
    endpoint: identity.endpoint(instanceId),
    pid,
    state: "ready",
    startedAt: 10,
    readyAt: 20,
    fileCount: 2,
    memoryCapBytes: 256 * 1024 * 1024,
  };
}

function spawnIdentifiableDaemon(
  identity: DaemonWorkspaceIdentity,
  instanceId: string,
  processToken: string,
  startedAt: number,
  processIds: number[],
): Promise<number> {
  if (process.platform !== "win32") {
    mkdirSync(dirname(identity.endpoint(instanceId)), { recursive: true, mode: 0o700 });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        identifiableDaemonSource,
        identity.endpoint(instanceId),
        instanceId,
        processToken,
        String(startedAt),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.once("error", reject);
    child.stdout?.once("data", () => {
      processIds.push(child.pid!);
      resolve(child.pid!);
    });
  });
}

const identifiableDaemonSource = `
const { createServer } = require("node:net");
const [endpoint, instanceId, processToken, startedAtText] = process.argv.slice(1);
const startedAt = Number(startedAtText);
const frame = (value) => {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
};
const server = createServer((socket) => {
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) return;
    const length = bytes.readUInt32BE(0);
    if (bytes.length < length + 4) return;
    const request = JSON.parse(bytes.subarray(4, length + 4).toString("utf8"));
    if (request.kind === "identify") {
      socket.end(frame({ kind: "identity", instanceId, processToken, pid: process.pid, startedAt }));
      return;
    }
    if (request.kind === "terminate") {
      socket.end(frame({ kind: "terminating", instanceId, processToken }), () => server.close(() => process.exit(0)));
    }
  });
});
server.listen(endpoint, () => process.stdout.write("ready"));
`;
