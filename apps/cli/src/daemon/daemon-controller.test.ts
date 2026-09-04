import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestDaemonController as DaemonController } from "../../test/helpers/daemon-controller.js";
import type { DaemonProcessLauncher, DaemonProcessTerminator } from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonActivitySnapshot,
  type DaemonRecord,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { TestDaemonRegistry as DaemonRegistry } from "../../test/helpers/daemon-registry.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("DaemonController", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("uses coordinator startup recovery for explicit starts", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const registry = new DaemonRegistry(stateDirectory);
    const result = {
      status: "ready",
      workspaceRoot: "/repo",
      fileCount: 2,
      loadDurationMs: 10,
    } as const;
    const ensureRunning = vi
      .spyOn(DaemonStartupCoordinator.prototype, "ensureRunning")
      .mockResolvedValue(result);
    const trigger = vi
      .spyOn(DaemonStartupCoordinator.prototype, "trigger")
      .mockRejectedValue(new Error("Explicit start bypassed recovery"));
    const launcher: DaemonProcessLauncher = {
      symnavVersion: "0.1.0",
      memoryCapBytes: 1024,
      launch: vi.fn(),
    };
    const controller = new DaemonController(
      registry,
      new ControllerTransport() as unknown as LocalDaemonTransport,
      stateDirectory,
      { launcher },
    );

    await expect(controller.start("/repo")).resolves.toEqual(result);

    expect(ensureRunning).toHaveBeenCalledOnce();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("waits for an armed launch to publish its process before stopping it", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const lease = registry.acquireStartup(identity, "starting");
    expect(lease).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, startingRecord(identity))).toBe(true);
    expect(registry.armStartingProcessLaunch(identity, startingRecord(identity))).toBe(true);
    const terminator = new BlockingControllerTerminator([process.pid, 7000]);
    const controller = new DaemonController(
      registry,
      new ControllerTransport() as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: terminator, stopTimeoutMs: 1_000, pollIntervalMs: 1 },
    );

    const stopping = controller.stop("/repo");
    const published = registry.writeStartingIfStartupOwner(identity, {
      ...startingRecord(identity),
      pid: 7000,
    });

    expect(published).toBe(true);
    await terminator.waitUntilTerminationRequested();
    expect(registry.startupOwner(identity)).toBeDefined();
    expect(registry.readStoredInstance(identity, "starting")?.pid).toBe(7000);
    terminator.allowExit();

    await expect(stopping).resolves.toEqual({
      status: "stopped",
      workspaceRoot: "/repo",
      pid: 7000,
    });
    expect(registry.startupOwner(identity)).toBeUndefined();
    expect(registry.readStoredInstance(identity, "starting")).toBeUndefined();
    lease?.release();
  });

  it("retains starting ownership until the exact launched process exits", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const record = { ...startingRecord(identity), pid: 7001 } satisfies DaemonRecord;
    expect(registry.acquireStartup(identity, record.instanceId)).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, record)).toBe(true);
    const terminator = new BlockingControllerTerminator([process.pid, record.pid]);
    const controller = new DaemonController(
      registry,
      new ControllerTransport() as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: terminator },
    );

    const stopping = controller.stop("/repo");
    try {
      const terminationRequested = await Promise.race([
        terminator.waitUntilTerminationRequested().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      expect(terminationRequested).toBe(true);
      expect(registry.startupOwner(identity)).toBeDefined();
      expect(registry.readStoredInstance(identity, record.instanceId)).toEqual(record);
    } finally {
      terminator.allowExit();
    }

    await expect(stopping).resolves.toEqual({
      status: "stopped",
      workspaceRoot: "/repo",
      pid: record.pid,
    });
    expect(terminator.isAlive(record.pid)).toBe(false);
    expect(registry.startupOwner(identity)).toBeUndefined();
    expect(registry.readStoredInstance(identity, record.instanceId)).toBeUndefined();
  });

  it("reports a live starting daemon", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "starting")).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, startingRecord(identity))).toBe(true);
    const controller = new DaemonController(
      registry,
      new ControllerTransport() as unknown as LocalDaemonTransport,
      stateDirectory,
      {
        processTerminator: new ControllerTerminator([process.pid]),
        now: () => 20,
      },
    );

    await expect(controller.status()).resolves.toEqual([
      {
        workspaceRoot: "/repo",
        state: "starting",
        pid: 0,
        startupElapsedMs: 10,
      },
    ]);
  });

  it("reports authenticated startup before activity is available", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const daemonRecord = { ...startingRecord(identity), pid: 101 } satisfies DaemonRecord;
    expect(registry.acquireStartup(identity, daemonRecord.instanceId)).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, daemonRecord)).toBe(true);
    const controller = new DaemonController(
      registry,
      new ActivityControllerTransport(daemonRecord) as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: new ControllerTerminator([daemonRecord.pid]), now: () => 20 },
    );

    await expect(controller.status()).resolves.toEqual([
      {
        workspaceRoot: "/repo",
        state: "starting",
        pid: daemonRecord.pid,
        startupElapsedMs: 10,
      },
    ]);
  });

  it.each([
    [
      "ready",
      activity({ lifecycle: "ready", fileCount: 3 }),
      { state: "ready", uptimeMs: 5_000, fileCount: 3 },
    ],
    [
      "busy",
      activity({
        lifecycle: "busy",
        fileCount: 3,
        current: { requestId: "request-one", command: "refs", elapsedMs: 200 },
      }),
      { state: "busy", uptimeMs: 5_000, command: "refs", elapsedMs: 200 },
    ],
    [
      "recovering",
      activity({ lifecycle: "recovering", recoveryDetail: "worker-replacement" }),
      { state: "recovering", uptimeMs: 5_000, detail: "worker-replacement" },
    ],
    [
      "draining",
      activity({ lifecycle: "draining" }),
      { state: "recovering", uptimeMs: 5_000, detail: "draining" },
    ],
  ] as const)(
    "uses daemon monotonic uptime for %s activity",
    async (_label, snapshot, expected) => {
      const stateDirectory = temporaryDirectory(roots);
      const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
      const registry = new DaemonRegistry(identity.registryDirectory);
      const daemonRecord = readyRecord(identity);
      registry.write(daemonRecord);
      const controller = new DaemonController(
        registry,
        new ActivityControllerTransport(daemonRecord, snapshot) as unknown as LocalDaemonTransport,
        stateDirectory,
        { processTerminator: new ControllerTerminator([daemonRecord.pid]), now: () => -10_000 },
      );

      await expect(controller.status()).resolves.toEqual([
        expect.objectContaining({ workspaceRoot: "/repo", pid: daemonRecord.pid, ...expected }),
      ]);
    },
  );

  it("reports authenticated recovery while the registry still says starting", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const daemonRecord = { ...startingRecord(identity), pid: 101 } satisfies DaemonRecord;
    expect(registry.acquireStartup(identity, daemonRecord.instanceId)).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, daemonRecord)).toBe(true);
    const snapshot = activity({
      lifecycle: "recovering",
      recoveryDetail: "worker-replacement",
      startupElapsedMs: 7_000,
    });
    const controller = new DaemonController(
      registry,
      new ActivityControllerTransport(daemonRecord, snapshot) as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: new ControllerTerminator([daemonRecord.pid]), now: () => 20 },
    );

    await expect(controller.status()).resolves.toEqual([
      expect.objectContaining({
        workspaceRoot: "/repo",
        state: "recovering",
        pid: daemonRecord.pid,
        uptimeMs: 7_000,
        detail: "worker-replacement",
      }),
    ]);
    expect(registry.readStoredInstance(identity, daemonRecord.instanceId)).toEqual(daemonRecord);
  });

  it("cleans stale starting state while reporting status", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "starting")).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, startingRecord(identity))).toBe(true);
    const owner = registry.startupOwner(identity);
    writeFileSync(
      identity.startupOwnerPath(identity.lockPath),
      JSON.stringify({ ...owner, heartbeatAt: Date.now() - 60_000 }),
    );
    const controller = new DaemonController(
      registry,
      new ControllerTransport() as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: new ControllerTerminator([]) },
    );

    await expect(controller.status()).resolves.toEqual([]);
    expect(registry.startupOwner(identity)).toBeUndefined();
    expect(registry.readStoredInstance(identity, "starting")).toBeUndefined();
  });

  it("preserves a replacement startup lock while cleaning an observed dead process", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const observed = { ...startingRecord(identity), pid: 7002 } satisfies DaemonRecord;
    const replacement = {
      ...observed,
      processToken: "replacement-process",
      pid: 7003,
      startedAt: 20,
    } satisfies DaemonRecord;
    expect(registry.acquireStartup(identity, observed.instanceId)).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, observed)).toBe(true);
    const terminator = new ReplacingControllerTerminator(observed.pid, () => {
      expect(registry.writeStartingIfStartupOwner(identity, replacement)).toBe(true);
    });
    const controller = new DaemonController(
      registry,
      new ControllerTransport() as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: terminator },
    );

    await expect(controller.status()).resolves.toEqual([]);
    expect(registry.startupOwner(identity)).toMatchObject({
      instanceId: replacement.instanceId,
      ownerPid: replacement.pid,
      processToken: replacement.processToken,
    });
    expect(registry.readStoredInstance(identity, replacement.instanceId)).toEqual(replacement);
  });
});

class ControllerTransport {
  request(_endpoint: string, _request: DaemonRequest): Promise<DaemonResponse> {
    throw new Error("Starting-daemon cancellation must not use transport");
  }

  async removeUnavailableEndpoint(_endpoint: string): Promise<boolean> {
    return true;
  }
}

class ActivityControllerTransport {
  constructor(
    private readonly record: DaemonRecord,
    private readonly activity?: DaemonActivitySnapshot,
  ) {}

  request(_endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    if (request.kind === "identify") {
      return Promise.resolve({
        kind: "identity",
        instanceId: this.record.instanceId,
        processToken: this.record.processToken,
        pid: this.record.pid,
        startedAt: this.record.startedAt,
      });
    }
    if (request.kind === "ping") {
      return Promise.resolve({
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: this.record.instanceId,
        symnavVersion: this.record.symnavVersion,
        startedAt: this.record.startedAt,
        ...(this.activity === undefined ? {} : { activity: this.activity }),
      });
    }
    return Promise.reject(new Error("Unexpected controller request"));
  }
}

class ControllerTerminator implements DaemonProcessTerminator {
  readonly alive: Set<number>;

  constructor(alive: readonly number[]) {
    this.alive = new Set(alive);
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async terminate(pid: number): Promise<void> {
    this.alive.delete(pid);
  }
}

class BlockingControllerTerminator implements DaemonProcessTerminator {
  readonly alive: Set<number>;
  private readonly terminationRequested: Promise<void>;
  private resolveTerminationRequested!: () => void;
  private readonly exitAllowed: Promise<void>;
  private resolveExitAllowed!: () => void;

  constructor(alive: readonly number[]) {
    this.alive = new Set(alive);
    this.terminationRequested = new Promise((resolve) => {
      this.resolveTerminationRequested = resolve;
    });
    this.exitAllowed = new Promise((resolve) => {
      this.resolveExitAllowed = resolve;
    });
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async terminate(pid: number): Promise<void> {
    this.resolveTerminationRequested();
    await this.exitAllowed;
    this.alive.delete(pid);
  }

  waitUntilTerminationRequested(): Promise<void> {
    return this.terminationRequested;
  }

  allowExit(): void {
    this.resolveExitAllowed();
  }
}

class ReplacingControllerTerminator implements DaemonProcessTerminator {
  private replaced = false;

  constructor(
    private readonly observedPid: number,
    private readonly replace: () => void,
  ) {}

  isAlive(pid: number): boolean {
    if (pid === this.observedPid && !this.replaced) {
      this.replaced = true;
      this.replace();
      return false;
    }
    return pid !== this.observedPid;
  }

  async terminate(): Promise<void> {}
}

function temporaryDirectory(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-controller-"));
  roots.push(root);
  return root;
}

function startingRecord(identity: DaemonWorkspaceIdentity, instanceId = "starting"): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: identity.workspaceRoot,
    workspaceKey: identity.workspaceKey,
    stateKey: identity.stateKey,
    identityKey: identity.identityKey,
    instanceId,
    processToken: `${instanceId}-process`,
    endpoint: identity.endpoint(instanceId),
    pid: 0,
    state: "starting",
    startedAt: 10,
    memoryCapBytes: 256 * 1024 * 1024,
  };
}
function readyRecord(identity: DaemonWorkspaceIdentity): DaemonRecord {
  return {
    ...startingRecord(identity, "ready"),
    pid: 101,
    state: "ready",
    readyAt: 20,
    fileCount: 3,
  };
}

function activity(
  overrides: Pick<DaemonActivitySnapshot, "lifecycle"> & Partial<DaemonActivitySnapshot>,
): DaemonActivitySnapshot {
  const { lifecycle, ...details } = overrides;
  return {
    lifecycle,
    pid: 101,
    startedAt: 10,
    startupElapsedMs: 5_000,
    processRssBytes: 4_096,
    hardProcessRssBytes: 8_192,
    workerGeneration: 1,
    queued: 0,
    spoolBytes: 0,
    ...details,
  };
}
