import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonController } from "./daemon-controller.js";
import type { DaemonProcessTerminator } from "./daemon-process-launcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
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

function temporaryDirectory(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "symnav-controller-"));
  roots.push(root);
  return root;
}

function startingRecord(identity: DaemonWorkspaceIdentity, instanceId = "starting"): DaemonRecord {
  return {
    schemaVersion: 1,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot: identity.workspaceRoot,
    workspaceKey: identity.workspaceKey,
    instanceId,
    processToken: `${instanceId}-process`,
    endpoint: identity.endpoint(instanceId),
    pid: 0,
    state: "starting",
    startedAt: 10,
    memoryCapBytes: 256 * 1024 * 1024,
  };
}
