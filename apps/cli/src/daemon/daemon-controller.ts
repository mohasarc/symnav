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
import { DaemonRecordObserver, type DaemonObservation } from "./daemon-record-observer.js";
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
  private readonly observer: DaemonRecordObserver;

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
    this.observer = new DaemonRecordObserver(this.transport, this.processTerminator, this.now);
  }

  async start(workspaceRoot: string): Promise<DaemonStartResult> {
    if (this.launcher === undefined) throw new Error("Daemon controller has no process launcher");
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    const coordinator = new DaemonStartupCoordinator(this.registry, this.launcher, this.transport);
    return coordinator.ensureRunning(identity);
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
    if (record.state === "starting") return this.stopStarting(identity, record, deadline);
    const observation = await this.observer.observe(record);
    if (observation.kind === "exited") {
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return { status: "not-running", workspaceRoot };
    }
    if (observation.kind === "unresponsive" || observation.kind === "starting") {
      throw new Error(`Daemon process ${record.pid} is live but unresponsive`);
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
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return { status: "stopped", workspaceRoot, pid: record.pid };
    }

    const killed = await this.killIdentified(record, deadline);
    if (!killed || !(await this.waitForIdentifiedExit(record, deadline))) {
      throw new Error(`Daemon process ${record.pid} did not exit after authenticated kill`);
    }
    this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
    return { status: "killed", workspaceRoot, pid: record.pid };
  }

  private async statusForRecord(record: DaemonRecord): Promise<RunningDaemonStatus | undefined> {
    const identity = DaemonWorkspaceIdentity.from(record.workspaceRoot, this.stateDirectory);
    if (record.state === "starting") {
      if (record.pid > 0) {
        const observation = await this.observer.observe(record);
        if (observation.kind === "exited") {
          this.removeStartingOwnership(identity, record);
          return undefined;
        }
        return this.startingStatus(record);
      }
      const owner = this.registry.startupOwner(identity);
      const armedLaunchIsWithinGrace =
        owner?.instanceId === record.instanceId &&
        owner.processToken === record.processToken &&
        this.registry.startupOwnerIsWithinGrace(owner);
      if (
        armedLaunchIsWithinGrace ||
        (owner?.instanceId === record.instanceId &&
          this.processTerminator.isAlive(owner.ownerPid) &&
          this.registry.startupOwnerIsWithinGrace(owner))
      ) {
        return this.startingStatus(record);
      }
      if (owner?.instanceId === record.instanceId) {
        if (!this.registry.removeStartupLockIfOwner(identity, owner)) {
          const renewedOwner = this.registry.startupOwner(identity);
          if (
            renewedOwner?.instanceId === record.instanceId &&
            this.processTerminator.isAlive(renewedOwner.ownerPid) &&
            this.registry.startupOwnerIsWithinGrace(renewedOwner)
          ) {
            return this.startingStatus(record);
          }
          return undefined;
        }
      }
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return undefined;
    }

    return this.statusForObservation(await this.observer.observe(record));
  }

  private async stopStarting(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
    deadline: number,
  ): Promise<DaemonStopResult> {
    const owner = this.registry.startupOwner(identity);
    if (record.pid <= 0) {
      if (owner?.processToken === record.processToken) {
        return this.waitForClaimedProcessAndStop(identity, record, deadline);
      }
      if (owner?.instanceId === record.instanceId)
        this.registry.removeStartupLockIfOwner(identity, owner);
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return { status: "not-running", workspaceRoot: record.workspaceRoot };
    }

    if (!this.processTerminator.isAlive(record.pid)) {
      this.removeStartingOwnership(identity, record);
      return { status: "not-running", workspaceRoot: record.workspaceRoot };
    }
    if (!this.registry.startupOwnerMatchesProcess(identity, record)) {
      throw new Error(`Daemon process ${record.pid} has no authenticated startup ownership`);
    }
    const terminated = await this.terminateStartingProcess(record.pid, deadline);
    if (!terminated || this.processTerminator.isAlive(record.pid)) {
      throw new Error(`Daemon process ${record.pid} did not exit after authenticated stop`);
    }
    this.registry.removeStartupLockIfProcess(identity, record);
    this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
    return { status: "stopped", workspaceRoot: record.workspaceRoot, pid: record.pid };
  }

  private async waitForClaimedProcessAndStop(
    identity: DaemonWorkspaceIdentity,
    claimedRecord: DaemonRecord,
    deadline: number,
  ): Promise<DaemonStopResult> {
    while (this.now() <= deadline) {
      const record = this.registry.readStoredInstance(identity, claimedRecord.instanceId);
      if (record === undefined || record.processToken !== claimedRecord.processToken) {
        return { status: "not-running", workspaceRoot: claimedRecord.workspaceRoot };
      }
      if (record.pid > 0) return this.stopStarting(identity, record, deadline);
      const owner = this.registry.startupOwner(identity);
      if (
        owner?.instanceId !== claimedRecord.instanceId ||
        owner.processToken !== claimedRecord.processToken
      ) {
        return { status: "not-running", workspaceRoot: claimedRecord.workspaceRoot };
      }
      await this.pause(this.pollIntervalMs);
    }
    throw new Error("Daemon launch did not publish its process before authenticated stop");
  }

  private async terminateStartingProcess(pid: number, deadline: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    const deadlineReached = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(0, deadline - this.now()));
    });
    try {
      return await Promise.race([
        this.processTerminator.terminate(pid).then(() => true),
        deadlineReached,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private removeStartingOwnership(identity: DaemonWorkspaceIdentity, record: DaemonRecord): void {
    const storedRecord = this.registry.readStoredInstance(identity, record.instanceId);
    if (
      storedRecord?.processToken !== record.processToken ||
      storedRecord.pid !== record.pid ||
      storedRecord.startedAt !== record.startedAt
    ) {
      return;
    }
    const owner = this.registry.startupOwner(identity);
    if (this.registry.startupOwnerMatchesProcess(identity, record)) {
      this.registry.removeStartupLockIfProcess(identity, record);
    } else if (owner?.instanceId === record.instanceId && owner.processToken === undefined) {
      this.registry.removeStartupLockIfOwner(identity, owner);
    }
    this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
  }

  private startingStatus(record: DaemonRecord): RunningDaemonStatus {
    return {
      workspaceRoot: record.workspaceRoot,
      state: "starting",
      pid: record.pid,
      uptimeMs: Math.max(0, this.now() - record.startedAt),
    };
  }

  private statusForObservation(observation: DaemonObservation): RunningDaemonStatus | undefined {
    const record = observation.record;
    if (observation.kind === "exited") {
      const identity = DaemonWorkspaceIdentity.from(record.workspaceRoot, this.stateDirectory);
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return undefined;
    }
    if (observation.kind !== "responsive") return this.unresponsiveStatus(record);
    const lastNavigationAt = observation.pong.lastNavigationAt ?? record.lastNavigationAt;
    const fileCount = observation.pong.fileCount ?? record.fileCount;
    const memoryBytes = observation.pong.memoryBytes ?? record.memoryBytes;
    return {
      workspaceRoot: record.workspaceRoot,
      state: observation.pong.state === "busy" ? "busy" : "ready",
      pid: record.pid,
      uptimeMs: Math.max(0, this.now() - record.startedAt),
      ...(fileCount === undefined ? {} : { fileCount }),
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
      ...(lastNavigationAt === undefined
        ? {}
        : { lastRequestAgoMs: Math.max(0, this.now() - lastNavigationAt) }),
      ...(observation.pong.currentCommand === undefined
        ? {}
        : { currentCommand: observation.pong.currentCommand }),
      ...(observation.pong.currentCommandElapsedMs === undefined
        ? {}
        : { currentCommandElapsedMs: observation.pong.currentCommandElapsedMs }),
      ...(observation.pong.queued === undefined ? {} : { queued: observation.pong.queued }),
    };
  }

  private unresponsiveStatus(record: DaemonRecord): RunningDaemonStatus {
    return {
      workspaceRoot: record.workspaceRoot,
      state: "unresponsive",
      pid: record.pid,
      uptimeMs: Math.max(0, this.now() - record.startedAt),
      ...(record.fileCount === undefined ? {} : { fileCount: record.fileCount }),
      ...(record.memoryBytes === undefined ? {} : { memoryBytes: record.memoryBytes }),
      ...(record.lastNavigationAt === undefined
        ? {}
        : { lastRequestAgoMs: Math.max(0, this.now() - record.lastNavigationAt) }),
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
