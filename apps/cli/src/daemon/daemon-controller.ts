import { randomUUID } from "node:crypto";
import type {
  DaemonRecord,
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";
import {
  NodeDaemonProcessTerminator,
  type DaemonProcessTerminator,
  type DaemonProcessLauncher,
} from "./daemon-process-launcher.js";
import type { DaemonRegistry } from "./daemon-registry.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

interface DaemonControllerOptions {
  readonly now?: () => number;
  readonly stopTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly launcher?: DaemonProcessLauncher;
}

export class DaemonController {
  private readonly now: () => number;
  private readonly stopTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly processTerminator: DaemonProcessTerminator;
  private readonly launcher: DaemonProcessLauncher | undefined;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: LocalDaemonTransport,
    private readonly stateDirectory: string,
    options: DaemonControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 20;
    this.processTerminator = options.processTerminator ?? new NodeDaemonProcessTerminator();
    this.launcher = options.launcher;
  }

  start(workspaceRoot: string): Promise<DaemonStartResult> {
    if (this.launcher === undefined) throw new Error("Daemon controller has no process launcher");
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    return new DaemonStartupCoordinator(this.registry, this.launcher, this.transport).ensureRunning(
      identity,
    );
  }

  async status(): Promise<readonly RunningDaemonStatus[]> {
    const statuses = await Promise.all(
      this.registry.list().map((record) => this.statusForRecord(record)),
    );
    return statuses
      .filter((status): status is RunningDaemonStatus => status !== undefined)
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
  }

  async stop(workspaceRoot: string): Promise<DaemonStopResult> {
    const stopStartedAt = this.now();
    const deadline = stopStartedAt + this.stopTimeoutMs;
    const forceWaitMs = Math.min(500, Math.floor(this.stopTimeoutMs / 2));
    const gracefulDeadline = deadline - forceWaitMs;
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    const record = this.registry.read(identity);
    if (record === undefined) {
      return { status: "not-running", workspaceRoot };
    }
    if (record.state === "starting") return this.stopStarting(identity, record);
    if (!(await this.identifies(record))) {
      this.registry.removeIfInstance(identity, record.instanceId);
      return { status: "not-running", workspaceRoot };
    }

    const stopRequest = this.transport
      .request(record.endpoint, {
        kind: "stop",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: record.instanceId,
      })
      .then(() => true)
      .catch(() => false);
    const acknowledged = await Promise.race([
      stopRequest,
      this.pause(Math.max(0, gracefulDeadline - this.now())).then(() => false),
    ]);
    if (acknowledged && (await this.waitForExit(record.pid, gracefulDeadline))) {
      this.registry.removeIfInstance(identity, record.instanceId);
      return { status: "stopped", workspaceRoot, pid: record.pid };
    }

    const killed = await this.killIdentified(record, deadline);
    if (!killed || !(await this.waitForIdentifiedExit(record, deadline))) {
      throw new Error(`Daemon process ${record.pid} did not exit after authenticated kill`);
    }
    this.registry.removeIfInstance(identity, record.instanceId);
    return { status: "killed", workspaceRoot, pid: record.pid };
  }

  private async statusForRecord(record: DaemonRecord): Promise<RunningDaemonStatus | undefined> {
    const identity = DaemonWorkspaceIdentity.from(record.workspaceRoot, this.stateDirectory);
    if (record.state === "starting") {
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
      await this.removeStaleRecord(identity, record);
      return undefined;
    }

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
      await this.removeStaleRecord(identity, record);
      return undefined;
    }
  }

  private async stopStarting(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
  ): Promise<DaemonStopResult> {
    const owner = this.registry.startupOwner(identity);
    if (
      owner?.instanceId !== record.instanceId ||
      !this.registry.startupOwnerIsWithinGrace(owner) ||
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

  private startingStatus(record: DaemonRecord): RunningDaemonStatus {
    return {
      workspaceRoot: record.workspaceRoot,
      state: "starting",
      pid: record.pid,
      uptimeMs: Math.max(0, this.now() - record.startedAt),
    };
  }

  private async killIdentified(record: DaemonRecord, deadline: number): Promise<boolean> {
    try {
      const response = await Promise.race([
        this.transport.request(record.endpoint, {
          kind: "kill",
          instanceId: record.instanceId,
          processToken: record.processToken,
        }),
        this.pause(Math.max(0, deadline - this.now())).then(() => undefined),
      ]);
      return response?.kind === "killing";
    } catch {
      return false;
    }
  }

  private async waitForIdentifiedExit(record: DaemonRecord, deadline: number): Promise<boolean> {
    while (this.now() <= deadline) {
      if (!(await this.identifies(record)) && !this.processTerminator.isAlive(record.pid)) {
        return true;
      }
      await this.pause(this.pollIntervalMs);
    }
    return !(await this.identifies(record)) && !this.processTerminator.isAlive(record.pid);
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

  private async identifies(record: DaemonRecord): Promise<boolean> {
    try {
      const response = await this.transport.request(record.endpoint, {
        kind: "identify",
        instanceId: record.instanceId,
        processToken: record.processToken,
      });
      return (
        response.kind === "identity" &&
        response.pid === record.pid &&
        response.startedAt === record.startedAt
      );
    } catch {
      return false;
    }
  }

  private async waitForExit(pid: number, deadline: number): Promise<boolean> {
    while (this.now() <= deadline) {
      if (!this.processTerminator.isAlive(pid)) return true;
      await this.pause(this.pollIntervalMs);
    }
    return !this.processTerminator.isAlive(pid);
  }

  private pause(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}
