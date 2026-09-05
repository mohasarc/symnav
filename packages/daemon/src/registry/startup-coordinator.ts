import { randomUUID } from "node:crypto";
import type { DaemonPolicyValues } from "@symnav/daemon";
import {
  DaemonProcessTerminationError,
  NodeDaemonProcessTerminator,
  type DaemonProcess,
  type DaemonProcessExit,
  type DaemonProcessLauncher,
  type DaemonProcessTerminator,
} from "../process/process-launcher.js";
import type { DaemonRecord, DaemonStartResult } from "../transport/protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "../transport/protocol.js";
import type { DaemonRegistry, StartupOwner } from "./registry.js";
import { DaemonRecordObserver } from "./record-observer.js";
import type { DaemonWorkspaceIdentity } from "./workspace-identity.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequestSender,
} from "../transport/contracts.js";
import { NodeDaemonClock, type DaemonClock } from "../lifecycle/daemon-clock.js";

export type DaemonWarmupTriggerResult =
  | { readonly status: "launched"; readonly instanceId: string; readonly pid: number }
  | { readonly status: "starting"; readonly instanceId: string; readonly pid: number }
  | { readonly status: "ready"; readonly instanceId: string; readonly pid: number };

interface DaemonStartupCoordinatorOptions {
  readonly policy: Pick<DaemonPolicyValues, "startup" | "shutdown">;
  readonly clock?: Pick<DaemonClock, "wallNowMs">;
  readonly instanceId?: () => string;
  readonly processTerminator?: DaemonProcessTerminator;
}

class DaemonChildExitError extends Error {
  constructor(readonly exit: DaemonProcessExit) {
    super(
      exit.cause === "spawn-error"
        ? `Daemon child failed after spawn (${exit.errorName ?? "Error"})`
        : `Daemon child exited before readiness (code ${String(exit.code)}, signal ${String(exit.signal)})`,
    );
  }
}

class DaemonWarmupLostError extends Error {}

class DaemonOwnedButUnresponsiveError extends Error {}

export class DaemonStartupCoordinator {
  private readonly coordinationGraceMs: number;
  private readonly childFailureRetryLimit: number;
  private readonly terminationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: Pick<DaemonClock, "wallNowMs">;
  private readonly nextInstanceId: () => string;
  private readonly processTerminator: DaemonProcessTerminator;
  private readonly observer: DaemonRecordObserver;
  private readonly launchedInstances = new Set<string>();
  private readonly launchedProcesses = new Map<string, DaemonProcess>();
  private readonly launchedExits = new Map<string, DaemonProcessExit>();
  private readonly launchedInstanceIdsByIdentity = new Map<string, string>();

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly launcher: DaemonProcessLauncher,
    private readonly transport: DaemonLifecycleRequestSender & DaemonExecutionRequester,
    options: DaemonStartupCoordinatorOptions,
  ) {
    const policy = options.policy;
    this.coordinationGraceMs = policy.startup.coordinationGraceMs;
    this.childFailureRetryLimit = policy.startup.childFailureRetryLimit;
    this.terminationTimeoutMs = policy.startup.previousInstanceTerminationTimeoutMs;
    this.pollIntervalMs = policy.startup.observationPollIntervalMs;
    this.clock = options.clock ?? new NodeDaemonClock();
    this.nextInstanceId = options.instanceId ?? randomUUID;
    this.processTerminator =
      options.processTerminator ?? new NodeDaemonProcessTerminator(policy.shutdown, this.clock);
    this.observer = new DaemonRecordObserver(this.transport, this.processTerminator);
  }

  async ensureRunning(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    let failureCount = 0;
    while (true) {
      try {
        return await this.triggerAndWait(identity);
      } catch (error) {
        if (
          !(error instanceof DaemonChildExitError || error instanceof DaemonWarmupLostError) ||
          failureCount >= this.childFailureRetryLimit
        ) {
          throw error;
        }
        failureCount += 1;
      }
    }
  }

  private async triggerAndWait(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    const trigger = await this.trigger(identity);
    return this.waitUntilReady(identity, trigger.instanceId);
  }

  async trigger(identity: DaemonWorkspaceIdentity): Promise<DaemonWarmupTriggerResult> {
    const readyRecord = await this.validatedReadyRecord(identity);
    if (readyRecord?.symnavVersion === this.launcher.symnavVersion) {
      return {
        status: "ready",
        instanceId: readyRecord.instanceId,
        pid: readyRecord.pid,
      };
    }

    const instanceId = this.nextInstanceId();
    const processToken = randomUUID();
    const lease = this.registry.acquireStartup(identity, {
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      ownerPid: process.pid,
      ownerKind: "launcher",
      heartbeatAt: this.clock.wallNowMs(),
    });
    if (lease === undefined) return this.observeElectedWarmup(identity);
    try {
      const currentRecord = await this.validatedReadyRecord(identity);
      if (currentRecord?.symnavVersion === this.launcher.symnavVersion) {
        lease.release();
        return {
          status: "ready",
          instanceId: currentRecord.instanceId,
          pid: currentRecord.pid,
        };
      }
      const storedRecord = this.registry.readStored(identity);
      if (storedRecord !== undefined) await this.replaceStoredRecord(identity, storedRecord);
      return await this.launch(identity, instanceId, processToken, lease);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async waitUntilReady(
    identity: DaemonWorkspaceIdentity,
    expectedInstanceId?: string,
  ): Promise<DaemonStartResult> {
    let missingOwner: { readonly instanceId: string; readonly firstObservedAt: number } | undefined;
    while (true) {
      const record = this.registry.read(identity);
      if (record?.state === "ready" && record.symnavVersion === this.launcher.symnavVersion) {
        const validated = await this.validatedChildRecord(identity);
        if (validated?.instanceId === record.instanceId) {
          await this.probeExecution(validated);
          return this.launchedInstances.has(record.instanceId)
            ? {
                status: "ready",
                workspaceRoot: record.workspaceRoot,
                fileCount: record.fileCount ?? 0,
                loadDurationMs: (record.readyAt ?? this.clock.wallNowMs()) - record.startedAt,
              }
            : this.alreadyRunning(record);
        }
      }
      const storedRecord = this.registry.readStored(identity);
      const observedInstanceId =
        storedRecord?.instanceId ?? this.launchedInstanceIdsByIdentity.get(identity.identityKey);
      const launchedExit =
        observedInstanceId === undefined ? undefined : this.launchedExits.get(observedInstanceId);
      if (launchedExit !== undefined) throw new DaemonChildExitError(launchedExit);
      const owner = this.registry.startupOwner(identity);
      if (owner !== undefined) missingOwner = undefined;
      if (
        storedRecord?.state === "ready" &&
        storedRecord.symnavVersion === this.launcher.symnavVersion
      ) {
        await this.pause();
        continue;
      }
      if (storedRecord?.state === "starting") {
        if (owner !== undefined && this.startupOwnerIsAbandoned(identity, owner)) {
          if (this.cleanupAbandonedStartup(identity, owner)) {
            throw new DaemonWarmupLostError("Daemon child exited before readiness");
          }
          await this.pause();
          continue;
        }
        const daemonProcess = this.launchedProcesses.get(storedRecord.instanceId);
        if (daemonProcess !== undefined) {
          const childExit = await Promise.race([
            this.pause().then(() => undefined),
            daemonProcess.exited,
          ]);
          if (childExit !== undefined) throw new DaemonChildExitError(childExit);
          continue;
        }
        if (owner !== undefined) {
          await this.pause();
          continue;
        }
        if (missingOwner?.instanceId !== storedRecord.instanceId) {
          missingOwner = {
            instanceId: storedRecord.instanceId,
            firstObservedAt: this.clock.wallNowMs(),
          };
          await this.pause();
          continue;
        }
        if (this.clock.wallNowMs() - missingOwner.firstObservedAt <= this.coordinationGraceMs) {
          await this.pause();
          continue;
        }
      }
      if (owner !== undefined) {
        await this.pause();
        continue;
      }
      if (expectedInstanceId !== undefined) {
        throw new DaemonWarmupLostError(
          `Daemon startup ${expectedInstanceId} ended before readiness`,
        );
      }
      throw new Error("Daemon startup failed before readiness");
    }
  }

  private async launch(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
    lease: NonNullable<ReturnType<DaemonRegistry["acquireStartup"]>>,
  ): Promise<DaemonWarmupTriggerResult> {
    const startedAt = this.clock.wallNowMs();
    const startingRecord: DaemonRecord = {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: this.launcher.symnavVersion,
      workspaceRoot: identity.workspaceRoot,
      workspaceKey: identity.workspaceKey,
      stateKey: identity.stateKey,
      identityKey: identity.identityKey,
      instanceId,
      processToken,
      endpoint: identity.endpoint(instanceId),
      pid: 0,
      state: "starting",
      startedAt,
      memoryCapBytes: this.launcher.memoryCapBytes,
    };
    if (!this.registry.writeStartingIfStartupOwner(identity, startingRecord)) {
      throw new Error("Daemon startup ownership changed before process launch");
    }
    let daemonProcess: DaemonProcess | undefined;
    try {
      daemonProcess = await this.launcher.launch(identity, instanceId, processToken);
      const transferred = lease.transferToDaemon(daemonProcess.pid, processToken);
      if (
        !transferred &&
        !this.registry.daemonOwnsStartupProcess(
          identity,
          instanceId,
          processToken,
          daemonProcess.pid,
        )
      ) {
        throw new Error("Daemon startup ownership changed after process launch");
      }
      if (
        !this.registry.writeStartingIfStartupOwner(identity, {
          ...startingRecord,
          pid: daemonProcess.pid,
        })
      ) {
        throw new Error("Daemon startup ownership changed after process launch");
      }
      this.launchedInstances.add(instanceId);
      this.launchedProcesses.set(instanceId, daemonProcess);
      this.launchedInstanceIdsByIdentity.set(identity.identityKey, instanceId);
      this.observeLaunchedProcess(identity, instanceId, processToken, daemonProcess);
      return {
        status: "launched",
        instanceId,
        pid: daemonProcess.pid,
      };
    } catch (error) {
      if (error instanceof DaemonChildExitError) {
        this.cleanupLaunchedProcess(identity, instanceId, processToken);
        throw error;
      }
      if (daemonProcess !== undefined) {
        try {
          await daemonProcess.terminate();
        } catch (terminationError) {
          if (terminationError instanceof DaemonProcessTerminationError) throw terminationError;
          throw new DaemonProcessTerminationError(String(terminationError));
        }
      }
      this.cleanupLaunchedProcess(identity, instanceId, processToken);
      throw error;
    }
  }

  private observeLaunchedProcess(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
    daemonProcess: DaemonProcess,
  ): void {
    void daemonProcess.exited.then((exit) => {
      this.launchedExits.set(instanceId, exit);
      if (
        this.registry.startingRecordForProcess(identity, instanceId, processToken) !== undefined
      ) {
        this.cleanupLaunchedProcess(identity, instanceId, processToken);
      }
    });
  }

  private cleanupLaunchedProcess(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): void {
    const record = this.registry.recordForProcess(identity, instanceId, processToken);
    if (record !== undefined) {
      if (record.pid > 0) {
        this.registry.removeStartupLockIfProcess(identity, record);
      } else {
        this.registry.removeStartupLockIfLauncher(identity, instanceId, processToken);
      }
    }
    this.registry.removeIfProcess(identity, instanceId, processToken);
  }

  private async observeElectedWarmup(
    identity: DaemonWorkspaceIdentity,
  ): Promise<DaemonWarmupTriggerResult> {
    while (true) {
      const record = await this.validatedReadyRecord(identity);
      if (record?.symnavVersion === this.launcher.symnavVersion) {
        return { status: "ready", instanceId: record.instanceId, pid: record.pid };
      }
      const owner = this.registry.startupOwner(identity);
      if (owner === undefined) return this.trigger(identity);
      if (this.startupOwnerIsAbandoned(identity, owner)) {
        if (this.cleanupAbandonedStartup(identity, owner)) return this.trigger(identity);
      }
      const startingRecord = this.registry.readStoredInstance(identity, owner.instanceId);
      if (
        startingRecord?.state === "starting" &&
        startingRecord.pid > 0 &&
        owner.ownerKind === "daemon"
      ) {
        return {
          status: "starting",
          instanceId: owner.instanceId,
          pid: startingRecord.pid,
        };
      }
      await this.pause();
    }
  }

  private cleanupAbandonedStartup(identity: DaemonWorkspaceIdentity, owner: StartupOwner): boolean {
    return this.registry.removeAbandonedStartupOwner(identity, owner);
  }

  private startupOwnerIsAbandoned(identity: DaemonWorkspaceIdentity, owner: StartupOwner): boolean {
    const record = this.registry.readStoredInstance(identity, owner.instanceId);
    if (record !== undefined && record.pid > 0) {
      return !this.processTerminator.isAlive(record.pid);
    }
    if (owner.ownerKind === "daemon") return !this.processTerminator.isAlive(owner.ownerPid);
    return (
      !this.processTerminator.isAlive(owner.ownerPid) ||
      !this.registry.startupOwnerIsWithinGrace(owner)
    );
  }

  private async validatedChildRecord(
    identity: DaemonWorkspaceIdentity,
  ): Promise<DaemonRecord | undefined> {
    try {
      return await this.validatedReadyRecord(identity);
    } catch (error) {
      if (error instanceof DaemonOwnedButUnresponsiveError) return undefined;
      throw error;
    }
  }

  private async validatedReadyRecord(
    identity: DaemonWorkspaceIdentity,
  ): Promise<DaemonRecord | undefined> {
    const record = this.registry.read(identity);
    if (record?.state !== "ready") return undefined;
    const observation = await this.observer.observe(record);
    if (observation.kind === "responsive") {
      this.registry.removeStartupLockIfProcess(identity, record);
      return record;
    }
    if (observation.kind === "exited") {
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return undefined;
    }
    if (observation.kind === "incompatible" || observation.kind === "corrupt") return undefined;
    throw new DaemonOwnedButUnresponsiveError(
      `Daemon process ${record.pid} is live but unresponsive; ownership was retained`,
    );
  }

  private async replaceStoredRecord(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
  ): Promise<void> {
    const observation = await this.observer.observe(record);
    if (observation.kind === "exited") {
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      return;
    }
    if (observation.kind === "starting" || observation.kind === "unresponsive") {
      throw new DaemonOwnedButUnresponsiveError(
        `Daemon process ${record.pid} is live but unresponsive; ownership was retained`,
      );
    }
    await this.transport.request(record.endpoint, {
      kind: "terminate",
      instanceId: record.instanceId,
      processToken: record.processToken,
    });
    await this.waitForProcessExitAndEndpointRelease(record);
    this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
  }

  private async waitForProcessExitAndEndpointRelease(record: DaemonRecord): Promise<void> {
    const waitStartedAt = this.clock.wallNowMs();
    while (this.clock.wallNowMs() - waitStartedAt <= this.terminationTimeoutMs) {
      const endpointReleased = !(await this.identifiesRecordedProcess(record));
      const processExited = !this.processTerminator.isAlive(record.pid);
      if (endpointReleased && processExited) return;
      await this.pause();
    }
    throw new DaemonProcessTerminationError(
      `Daemon process ${record.pid} did not exit and release its endpoint`,
    );
  }

  private async identifiesRecordedProcess(record: DaemonRecord): Promise<boolean> {
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

  private async probeExecution(record: DaemonRecord): Promise<void> {
    const receipt = await this.transport.execute(record.endpoint, {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: record.instanceId,
      processToken: record.processToken,
      requestId: randomUUID(),
      commandName: "version",
      request: {
        argv: ["--version"],
        cwd: record.workspaceRoot,
        telemetryEnabled: false,
        executionMode: "cold",
      },
    });
    const completion = await receipt.completion;
    if (completion.status !== "completed" || completion.result.exitCode !== 0) {
      throw new Error("Daemon execution readiness probe failed");
    }
  }

  private alreadyRunning(record: DaemonRecord): DaemonStartResult {
    return {
      status: "already-running",
      workspaceRoot: record.workspaceRoot,
      pid: record.pid,
      uptimeMs: Math.max(0, this.clock.wallNowMs() - record.startedAt),
    };
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
}
