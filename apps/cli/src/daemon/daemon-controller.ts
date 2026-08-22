import { randomUUID } from "node:crypto";
import type { DaemonRegistry } from "./daemon-registry.js";
import {
  NodeDaemonProcessTerminator,
  type DaemonProcessLauncher,
  type DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";
import type {
  DaemonRecord,
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

interface DaemonControllerOptions {
  readonly launcher?: DaemonProcessLauncher;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly now?: () => number;
}

export class DaemonController {
  private readonly launcher: DaemonProcessLauncher | undefined;
  private readonly processTerminator: DaemonProcessTerminator;
  private readonly now: () => number;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: LocalDaemonTransport,
    private readonly stateDirectory: string,
    options: DaemonControllerOptions = {},
  ) {
    this.launcher = options.launcher;
    this.processTerminator = options.processTerminator ?? new NodeDaemonProcessTerminator();
    this.now = options.now ?? Date.now;
  }

  start(workspaceRoot: string): Promise<DaemonStartResult> {
    if (this.launcher === undefined) throw new Error("Daemon controller has no process launcher");
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    return new DaemonStartupCoordinator(this.registry, this.launcher, this.transport).ensureRunning(
      identity,
    );
  }

  async stop(workspaceRoot: string): Promise<DaemonStopResult> {
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    const record = this.registry.read(identity);
    if (record?.state !== "starting") {
      throw new Error("Ready daemon stopping is not available");
    }
    return this.stopStarting(identity, record);
  }

  async status(): Promise<readonly RunningDaemonStatus[]> {
    const statuses = await Promise.all(
      this.registry.list().map((record) => this.statusForRecord(record)),
    );
    return statuses
      .filter((status): status is RunningDaemonStatus => status !== undefined)
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
  }

  private async statusForRecord(record: DaemonRecord): Promise<RunningDaemonStatus | undefined> {
    if (record.state === "ready") return this.readyStatus(record);
    const identity = DaemonWorkspaceIdentity.from(record.workspaceRoot, this.stateDirectory);
    const owner = this.registry.startupOwner(identity);
    if (
      owner?.instanceId === record.instanceId &&
      this.registry.startupOwnerIsWithinGrace(owner) &&
      this.processTerminator.isAlive(owner.ownerPid)
    ) {
      return this.startingStatus(record);
    }
    if (owner?.instanceId === record.instanceId) {
      if (!this.registry.removeStartupLockIfOwner(identity, owner)) {
        const renewedOwner = this.registry.startupOwner(identity);
        if (
          renewedOwner?.instanceId === record.instanceId &&
          this.registry.startupOwnerIsWithinGrace(renewedOwner) &&
          this.processTerminator.isAlive(renewedOwner.ownerPid)
        ) {
          return this.startingStatus(record);
        }
        return undefined;
      }
    }
    this.registry.removeIfInstance(identity, record.instanceId);
    return undefined;
  }

  private async readyStatus(record: DaemonRecord): Promise<RunningDaemonStatus | undefined> {
    try {
      const response = await this.transport.request(record.endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: record.instanceId,
      });
      if (
        response.kind !== "pong" ||
        response.symnavVersion !== record.symnavVersion ||
        (response.startedAt !== undefined && response.startedAt !== record.startedAt)
      ) {
        return undefined;
      }
      const lastNavigationAt = response.lastNavigationAt ?? record.lastNavigationAt;
      const fileCount = response.fileCount ?? record.fileCount;
      const memoryBytes = response.memoryBytes ?? record.memoryBytes;
      return {
        workspaceRoot: record.workspaceRoot,
        state: "ready",
        pid: record.pid,
        uptimeMs: Math.max(0, this.now() - record.startedAt),
        ...(fileCount === undefined ? {} : { fileCount }),
        ...(memoryBytes === undefined ? {} : { memoryBytes }),
        ...(lastNavigationAt === undefined
          ? {}
          : { lastRequestAgoMs: Math.max(0, this.now() - lastNavigationAt) }),
      };
    } catch {
      await this.removeStaleRecord(
        DaemonWorkspaceIdentity.from(record.workspaceRoot, this.stateDirectory),
        record,
      );
      return undefined;
    }
  }

  private startingStatus(record: DaemonRecord): RunningDaemonStatus {
    return {
      workspaceRoot: record.workspaceRoot,
      state: "starting",
      pid: record.pid,
      uptimeMs: Math.max(0, this.now() - record.startedAt),
    };
  }

  private async removeStaleRecord(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
  ): Promise<void> {
    const lease = this.registry.acquireStartup(identity, `status-cleanup-${randomUUID()}`);
    if (lease === undefined) return;
    try {
      if (this.registry.readStoredInstance(identity, record.instanceId) === undefined) return;
      if (!(await this.transport.removeUnavailableEndpoint(record.endpoint))) return;
      this.registry.removeIfInstance(identity, record.instanceId);
    } finally {
      lease.release();
    }
  }

  private stopStarting(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
  ): DaemonStopResult {
    const owner = this.registry.startupOwner(identity);
    if (
      owner?.instanceId !== record.instanceId ||
      !this.processTerminator.isAlive(owner.ownerPid)
    ) {
      if (owner?.instanceId === record.instanceId) {
        this.registry.removeStartupLockIfInstance(identity, record.instanceId);
      }
      this.registry.removeIfInstance(identity, record.instanceId);
      return { status: "not-running", workspaceRoot: record.workspaceRoot };
    }
    this.registry.removeStartupLockIfInstance(identity, record.instanceId);
    this.registry.removeIfInstance(identity, record.instanceId);
    return record.pid > 0
      ? { status: "stopped", workspaceRoot: record.workspaceRoot, pid: record.pid }
      : { status: "not-running", workspaceRoot: record.workspaceRoot };
  }
}
