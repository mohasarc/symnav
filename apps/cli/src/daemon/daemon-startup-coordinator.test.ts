import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import {
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
  afterEach(() => {
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
