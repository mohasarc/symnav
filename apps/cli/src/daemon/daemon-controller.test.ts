import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonController } from "./daemon-controller.js";
import type { DaemonProcessTerminator } from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

describe("DaemonController", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("cancels a starting daemon without using transport", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    const lease = registry.acquireStartup(identity, "starting");
    expect(lease).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, startingRecord(identity))).toBe(true);
    const controller = new DaemonController(
      registry,
      new ControllerTransport() as unknown as LocalDaemonTransport,
      stateDirectory,
      { processTerminator: new ControllerTerminator([process.pid]) },
    );

    await expect(controller.stop("/repo")).resolves.toEqual({
      status: "not-running",
      workspaceRoot: "/repo",
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
        uptimeMs: 10,
      },
    ]);
  });

  it("cleans stale starting state while reporting status", async () => {
    const stateDirectory = temporaryDirectory(roots);
    const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
    const registry = new DaemonRegistry(identity.registryDirectory);
    expect(registry.acquireStartup(identity, "starting")).toBeDefined();
    expect(registry.writeStartingIfStartupOwner(identity, startingRecord(identity))).toBe(true);
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
});

class ControllerTransport {
  request(_endpoint: string, _request: DaemonRequest): Promise<DaemonResponse> {
    throw new Error("Starting-daemon cancellation must not use transport");
  }

  async removeUnavailableEndpoint(_endpoint: string): Promise<boolean> {
    return true;
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
