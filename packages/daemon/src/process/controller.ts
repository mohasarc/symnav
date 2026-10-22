import { DaemonFailureJournal } from "../diagnostics/failure-journal.js";
import { DaemonFailureRecorder } from "../diagnostics/failure-recorder.js";
import type { DaemonFailureEvent, DaemonStartupFailureStatus } from "../daemon-failure.js";
import type { DaemonStatusReport } from "../daemon-lifecycle-report.js";
import type { DaemonStateWriteFailureObserver } from "../state-write-failure.js";
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
  readonly policy: Pick<DaemonPolicyValues, "startup" | "shutdown" | "diagnostics">;
  readonly clock?: Pick<DaemonClock, "wallNowMs">;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly launcher?: DaemonProcessLauncher;
  readonly stateWriteFailed?: DaemonStateWriteFailureObserver;
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
  private readonly journal: DaemonFailureJournal;
  private readonly stateWriteFailed: DaemonStateWriteFailureObserver | undefined;
  private readonly policy: Pick<DaemonPolicyValues, "startup" | "shutdown" | "diagnostics">;

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
    this.stateWriteFailed = options.stateWriteFailed;
    this.journal = new DaemonFailureJournal(stateDirectory, this.policy.diagnostics, this.clock);
    this.observer = new DaemonRecordObserver(this.transport, this.processTerminator, (record) =>
      this.recordExited(record),
    );
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

  async status(): Promise<DaemonStatusReport> {
    const statuses = await Promise.all(
      this.registry.list().map((record) => this.statusForRecord(record)),
    );
    const daemons = statuses
      .filter((status): status is RunningDaemonStatus => status !== undefined)
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
    const events = await this.journal.recent(this.clock.wallNowMs()).catch(() => []);
    return this.statusReport(daemons, events);
  }

  private statusReport(
    daemons: readonly RunningDaemonStatus[],
    events: readonly DaemonFailureEvent[],
  ): DaemonStatusReport {
    const liveRoots = new Set(daemons.map((daemon) => daemon.workspaceRoot));
    const startupFailures = new Map<string, DaemonStartupFailureStatus>();
    for (const event of events) {
      if (event.kind === "startup-failure" && !liveRoots.has(event.workspaceRoot))
        startupFailures.set(event.workspaceRoot, {
          workspaceRoot: event.workspaceRoot,
          failure: event.failure,
        });
    }
    return {
      daemons: daemons.map((daemon) => {
        const fallbacks = events.filter(
          (event) => event.kind === "fallback" && event.workspaceRoot === daemon.workspaceRoot,
        );
        const latest = fallbacks.at(-1)?.failure;
        return latest === undefined
          ? daemon
          : { ...daemon, recentFallbacks: { count: fallbacks.length, latest } };
      }),
      ...(startupFailures.size === 0
        ? {}
        : {
            startupFailures: [...startupFailures.values()].sort((left, right) =>
              left.workspaceRoot.localeCompare(right.workspaceRoot),
            ),
          }),
    };
  }

  private async recordExited(record: DaemonRecord): Promise<void> {
    await new DaemonFailureRecorder(
      this.journal,
      record.workspaceRoot,
      this.clock,
      this.stateWriteFailed,
    ).record(
      record.state === "starting" ? "startup-failure" : "termination",
      "process spawn",
      "process-terminated",
      undefined,
      record.instanceId,
    );
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
    if (record.state === "starting")
      return this.stopStarting(identity, record, gracefulDeadline, deadline);
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
    await Promise.race([
      stopRequest,
      this.pause(Math.max(0, gracefulDeadline - this.clock.wallNowMs())).then(() => false),
    ]);
    if (await this.waitForExit(record, gracefulDeadline)) {
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
      const owner = this.registry.startupOwnerForInstance(identity, record.instanceId);
      const lifetime = record.processLifetime ?? owner?.ownerLifetime;
      if (!this.processTerminator.hasExited(record.pid || owner?.ownerPid || 0, lifetime))
        return this.startingStatus(record);
      if (owner !== undefined && !this.registry.removeStartupLockIfOwner(identity, owner))
        return this.startingStatus(record);
      await this.recordExited(record);
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return undefined;
    }

    return this.statusForObservation(await this.observer.observe(record));
  }

  private async stopStarting(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
    gracefulDeadline: number,
    deadline: number,
  ): Promise<DaemonStopResult> {
    if (record.pid <= 0) {
      if (this.registry.startupOwnerForRecordCredentials(identity, record) !== undefined) {
        return this.waitForClaimedProcessAndStop(identity, record, gracefulDeadline, deadline);
      }
      this.registry.removeStartupLockIfInstance(identity, record.instanceId);
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return { status: "not-running", workspaceRoot: record.workspaceRoot };
    }

    if (this.processTerminator.hasExited(record.pid, record.processLifetime)) {
      await this.recordExited(record);
      this.removeStartingOwnership(identity, record);
      return { status: "not-running", workspaceRoot: record.workspaceRoot };
    }
    if (!this.registry.startupOwnerMatchesProcess(identity, record)) {
      throw new Error(`Daemon process ${record.pid} has no authenticated startup ownership`);
    }
    if (!(await this.waitForStartingIdentity(record, deadline))) {
      if (this.processTerminator.hasExited(record.pid, record.processLifetime)) {
        this.removeStartingOwnership(identity, record);
        return { status: "not-running", workspaceRoot: record.workspaceRoot };
      }
      throw new Error(`Daemon process ${record.pid} is live but unresponsive`);
    }
    const terminated = await this.terminateStartingProcess(record, gracefulDeadline);
    if (terminated && (await this.waitForExit(record, gracefulDeadline))) {
      this.removeStartingOwnership(identity, record);
      return { status: "stopped", workspaceRoot: record.workspaceRoot, pid: record.pid };
    }
    const killed = await this.killIdentified(record, deadline);
    if (!killed || !(await this.waitForExit(record, deadline))) {
      throw new Error(`Daemon process ${record.pid} did not exit after authenticated kill`);
    }
    this.removeStartingOwnership(identity, record);
    return { status: "killed", workspaceRoot: record.workspaceRoot, pid: record.pid };
  }

  private async waitForClaimedProcessAndStop(
    identity: DaemonWorkspaceIdentity,
    claimedRecord: DaemonRecord,
    gracefulDeadline: number,
    deadline: number,
  ): Promise<DaemonStopResult> {
    while (this.clock.wallNowMs() <= deadline) {
      const record = this.registry.readStoredInstance(identity, claimedRecord.instanceId);
      if (record === undefined || record.processToken !== claimedRecord.processToken) {
        return { status: "not-running", workspaceRoot: claimedRecord.workspaceRoot };
      }
      if (record.pid > 0) return this.stopStarting(identity, record, gracefulDeadline, deadline);
      if (this.registry.startupOwnerForRecordCredentials(identity, claimedRecord) === undefined) {
        return { status: "not-running", workspaceRoot: claimedRecord.workspaceRoot };
      }
      await this.pause(this.pollIntervalMs);
    }
    throw new Error("Daemon launch did not publish its process before authenticated stop");
  }

  private async waitForStartingIdentity(record: DaemonRecord, deadline: number): Promise<boolean> {
    while (this.clock.wallNowMs() <= deadline) {
      const observation = await this.beforeDeadline(
        this.observer.observeIdentity(record),
        deadline,
      );
      if (observation?.kind === "authenticated") return true;
      if (observation === undefined || observation.kind === "exited") return false;
      await this.pause(this.pollIntervalMs);
    }
    return false;
  }

  private async terminateStartingProcess(record: DaemonRecord, deadline: number): Promise<boolean> {
    try {
      const response = await this.beforeDeadline(
        this.transport.request(record.endpoint, {
          kind: "terminate",
          instanceId: record.instanceId,
          processToken: record.processToken,
        }),
        deadline,
      );
      return response?.kind === "terminating";
    } catch {
      return false;
    }
  }

  private async beforeDeadline<Response>(
    operation: Promise<Response>,
    deadline: number,
  ): Promise<Response | undefined> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(
            () => resolve(undefined),
            Math.max(0, deadline - this.clock.wallNowMs()),
          );
        }),
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
      if (
        !(await this.identifies(record)) &&
        this.processTerminator.hasExited(record.pid, record.processLifetime)
      ) {
        return true;
      }
      await this.pause(this.pollIntervalMs);
    }
    return (
      !(await this.identifies(record)) &&
      this.processTerminator.hasExited(record.pid, record.processLifetime)
    );
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

  private async waitForExit(record: DaemonRecord, deadline: number): Promise<boolean> {
    while (this.clock.wallNowMs() <= deadline) {
      if (this.processTerminator.hasExited(record.pid, record.processLifetime)) return true;
      await this.pause(this.pollIntervalMs);
    }
    return this.processTerminator.hasExited(record.pid, record.processLifetime);
  }

  private pause(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}
