import type { DaemonPolicyValues } from "@symnav/daemon";
import type {
  DaemonRecord,
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
} from "../transport/protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "../transport/protocol.js";
import {
  NodeDaemonProcessTerminator,
  type DaemonProcessTerminator,
  type DaemonProcessLauncher,
} from "./process-launcher.js";
import type { DaemonRegistry } from "../registry/registry.js";
import { DaemonRecordObserver, type DaemonObservation } from "../registry/record-observer.js";
import { DaemonStartupCoordinator } from "../registry/startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { DaemonRuntimeValues } from "./runtime-values.js";
import { NodeDaemonClock, type DaemonClock } from "../lifecycle/daemon-clock.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequestSender,
} from "../transport/contracts.js";

interface DaemonControllerOptions {
  readonly policy: Pick<DaemonPolicyValues, "startup" | "shutdown">;
  readonly clock?: Pick<DaemonClock, "wallNowMs">;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly launcher?: DaemonProcessLauncher;
  readonly startupCoordinator?: Pick<DaemonStartupCoordinator, "ensureRunning">;
}

export class DaemonController {
  private readonly clock: Pick<DaemonClock, "wallNowMs">;
  private readonly stopTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly processTerminator: DaemonProcessTerminator;
  private readonly launcher: DaemonProcessLauncher | undefined;
  private readonly startupCoordinator: Pick<DaemonStartupCoordinator, "ensureRunning"> | undefined;
  private readonly observer: DaemonRecordObserver;
  private readonly policy: Pick<DaemonPolicyValues, "startup" | "shutdown">;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly transport: DaemonLifecycleRequestSender & DaemonExecutionRequester,
    private readonly stateDirectory: string,
    options: DaemonControllerOptions,
  ) {
    this.policy = options.policy;
    this.clock = options.clock ?? new NodeDaemonClock();
    this.stopTimeoutMs = this.policy.shutdown.stopTimeoutMs;
    this.pollIntervalMs = this.policy.shutdown.controllerPollIntervalMs;
    this.processTerminator =
      options.processTerminator ??
      new NodeDaemonProcessTerminator(this.policy.shutdown, this.clock);
    this.launcher = options.launcher;
    this.observer = new DaemonRecordObserver(this.transport, this.processTerminator);
    this.startupCoordinator =
      options.startupCoordinator ??
      (this.launcher === undefined
        ? undefined
        : new DaemonStartupCoordinator(this.registry, this.launcher, this.transport, {
            policy: this.policy,
          }));
  }

  async start(workspaceRoot: string): Promise<DaemonStartResult> {
    if (this.startupCoordinator === undefined) {
      throw new Error("Daemon controller has no process launcher");
    }
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    return this.startupCoordinator.ensureRunning(identity);
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
    const stopStartedAt = this.clock.wallNowMs();
    const deadline = stopStartedAt + this.stopTimeoutMs;
    const forceWaitMs = Math.min(
      this.policy.shutdown.forcedTerminationReserveMaximumMs,
      Math.floor(this.stopTimeoutMs / 2),
    );
    const gracefulDeadline = deadline - forceWaitMs;
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.stateDirectory);
    const record = this.registry.read(identity);
    if (record === undefined) {
      return { status: "not-running", workspaceRoot };
    }
    if (record.state === "starting") return this.stopStarting(identity, record, deadline);
    const observation = await this.observer.observeIdentity(record);
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
      this.pause(Math.max(0, gracefulDeadline - this.clock.wallNowMs())).then(() => false),
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
        if (observation.kind === "starting") return this.startingStatus(record);
        if (observation.kind === "responsive" && observation.pong.activity === undefined) {
          return this.startingStatus(record);
        }
        return this.statusForObservation(observation);
      }
      const ownerForRecord = this.registry.startupOwnerForRecordCredentials(identity, record);
      const ownerForInstance = this.registry.startupOwnerForInstance(identity, record.instanceId);
      const armedLaunchIsWithinGrace =
        ownerForRecord !== undefined && this.registry.startupOwnerIsWithinGrace(ownerForRecord);
      if (
        armedLaunchIsWithinGrace ||
        (ownerForInstance !== undefined &&
          this.processTerminator.isAlive(ownerForInstance.ownerPid) &&
          this.registry.startupOwnerIsWithinGrace(ownerForInstance))
      ) {
        return this.startingStatus(record);
      }
      if (ownerForInstance !== undefined) {
        if (!this.registry.removeStartupLockIfOwner(identity, ownerForInstance)) {
          const renewedOwner = this.registry.startupOwnerForInstance(identity, record.instanceId);
          if (
            renewedOwner !== undefined &&
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
    if (record.pid <= 0) {
      if (this.registry.startupOwnerForRecordCredentials(identity, record) !== undefined) {
        return this.waitForClaimedProcessAndStop(identity, record, deadline);
      }
      this.registry.removeStartupLockIfInstance(identity, record.instanceId);
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
    while (this.clock.wallNowMs() <= deadline) {
      const record = this.registry.readStoredInstance(identity, claimedRecord.instanceId);
      if (record === undefined || record.processToken !== claimedRecord.processToken) {
        return { status: "not-running", workspaceRoot: claimedRecord.workspaceRoot };
      }
      if (record.pid > 0) return this.stopStarting(identity, record, deadline);
      if (this.registry.startupOwnerForRecordCredentials(identity, claimedRecord) === undefined) {
        return { status: "not-running", workspaceRoot: claimedRecord.workspaceRoot };
      }
      await this.pause(this.pollIntervalMs);
    }
    throw new Error("Daemon launch did not publish its process before authenticated stop");
  }

  private async terminateStartingProcess(pid: number, deadline: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    const deadlineReached = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(0, deadline - this.clock.wallNowMs()));
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
    if (this.registry.startupOwnerMatchesProcess(identity, record)) {
      this.registry.removeStartupLockIfProcess(identity, record);
    }
    this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
  }

  private startingStatus(record: DaemonRecord): RunningDaemonStatus {
    return {
      workspaceRoot: record.workspaceRoot,
      state: "starting",
      pid: record.pid,
      startupElapsedMs: Math.max(0, this.clock.wallNowMs() - record.startedAt),
      ...(record.memoryBytes === undefined ? {} : { memoryBytes: record.memoryBytes }),
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
    if (observation.pong.activity !== undefined) {
      return this.statusFromActivity(record, observation.pong.activity);
    }
    const lastNavigationAt = observation.pong.lastNavigationAt ?? record.lastNavigationAt;
    const fileCount = observation.pong.fileCount ?? record.fileCount;
    const memoryBytes = observation.pong.memoryBytes ?? record.memoryBytes;
    if (observation.pong.state === "busy") {
      if (
        observation.pong.currentCommand === undefined ||
        observation.pong.currentCommandElapsedMs === undefined ||
        observation.pong.queued === undefined ||
        memoryBytes === undefined
      ) {
        return this.unresponsiveStatus(record);
      }
      return {
        workspaceRoot: record.workspaceRoot,
        state: "busy",
        pid: record.pid,
        uptimeMs: Math.max(0, this.clock.wallNowMs() - record.startedAt),
        command: DaemonRuntimeValues.isCommandName(observation.pong.currentCommand)
          ? observation.pong.currentCommand
          : "unknown",
        elapsedMs: observation.pong.currentCommandElapsedMs,
        queued: observation.pong.queued,
        memoryBytes,
      };
    }
    if (fileCount === undefined || memoryBytes === undefined) {
      return this.unresponsiveStatus(record);
    }
    return {
      workspaceRoot: record.workspaceRoot,
      state: "ready",
      pid: record.pid,
      uptimeMs: Math.max(0, this.clock.wallNowMs() - record.startedAt),
      fileCount,
      memoryBytes,
      ...(lastNavigationAt === undefined
        ? {}
        : { lastRequestAgoMs: Math.max(0, this.clock.wallNowMs() - lastNavigationAt) }),
    };
  }

  private unresponsiveStatus(record: DaemonRecord): RunningDaemonStatus {
    return {
      workspaceRoot: record.workspaceRoot,
      state: "unresponsive",
      pid: record.pid,
      uptimeMs: Math.max(0, this.clock.wallNowMs() - record.startedAt),
    };
  }

  private statusFromActivity(
    record: DaemonRecord,
    activity: import("../transport/protocol.js").DaemonActivitySnapshot,
  ): RunningDaemonStatus {
    if (activity.lifecycle === "starting") {
      return {
        state: "starting",
        workspaceRoot: record.workspaceRoot,
        pid: record.pid,
        startupElapsedMs: activity.startupElapsedMs,
        memoryBytes: activity.processRssBytes,
      };
    }
    const uptimeMs = activity.startupElapsedMs;
    if (activity.lifecycle === "busy" && activity.current !== undefined) {
      return {
        state: "busy",
        workspaceRoot: record.workspaceRoot,
        pid: record.pid,
        uptimeMs,
        command: activity.current.command,
        elapsedMs: activity.current.elapsedMs,
        queued: activity.queued,
        memoryBytes: activity.processRssBytes,
      };
    }
    if (activity.lifecycle === "recovering" || activity.lifecycle === "draining") {
      const detail = activity.lifecycle === "draining" ? "draining" : activity.recoveryDetail;
      if (detail === undefined) return this.unresponsiveStatus(record);
      return {
        state: "recovering",
        workspaceRoot: record.workspaceRoot,
        pid: record.pid,
        uptimeMs,
        detail,
        queued: activity.queued,
        memoryBytes: activity.processRssBytes,
      };
    }
    if (activity.fileCount === undefined) return this.unresponsiveStatus(record);
    return {
      state: "ready",
      workspaceRoot: record.workspaceRoot,
      pid: record.pid,
      uptimeMs,
      fileCount: activity.fileCount,
      memoryBytes: activity.processRssBytes,
      ...(activity.lastCompletedAgoMs === undefined
        ? {}
        : { lastRequestAgoMs: activity.lastCompletedAgoMs }),
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
        this.pause(Math.max(0, deadline - this.clock.wallNowMs())).then(() => undefined),
      ]);
      return response?.kind === "killing";
    } catch {
      return false;
    }
  }

  private async waitForIdentifiedExit(record: DaemonRecord, deadline: number): Promise<boolean> {
    while (this.clock.wallNowMs() <= deadline) {
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
    while (this.clock.wallNowMs() <= deadline) {
      if (!this.processTerminator.isAlive(pid)) return true;
      await this.pause(this.pollIntervalMs);
    }
    return !this.processTerminator.isAlive(pid);
  }

  private pause(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}
