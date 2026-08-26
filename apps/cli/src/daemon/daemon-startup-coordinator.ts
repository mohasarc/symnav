import { randomUUID } from "node:crypto";
import {
  DaemonProcessTerminationError,
  NodeDaemonProcessTerminator,
  type DaemonProcess,
  type DaemonProcessExit,
  type DaemonProcessLauncher,
  type DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import type { DaemonRecord, DaemonStartResult } from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import {
  DAEMON_STARTUP_TIMEOUT_MS,
  type DaemonRegistry,
  type StartupOwner,
} from "./daemon-registry.js";
import { DaemonRecordObserver } from "./daemon-record-observer.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

export type DaemonWarmupTriggerResult =
  | { readonly status: "launched"; readonly instanceId: string; readonly pid: number }
  | { readonly status: "starting"; readonly instanceId: string; readonly pid: number }
  | { readonly status: "ready"; readonly instanceId: string; readonly pid: number };

interface DaemonStartupCoordinatorOptions {
  readonly startupTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly instanceId?: () => string;
  readonly processTerminator?: DaemonProcessTerminator;
}

const DAEMON_TERMINATION_TIMEOUT_MS = 5 * 60_000;
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
  private readonly startupTimeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
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
    private readonly transport: LocalDaemonTransport,
    options: DaemonStartupCoordinatorOptions = {},
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? Number.POSITIVE_INFINITY;
    this.terminationTimeoutMs = options.terminationTimeoutMs ?? DAEMON_TERMINATION_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 20;
    this.now = options.now ?? Date.now;
    this.nextInstanceId = options.instanceId ?? randomUUID;
    this.processTerminator = options.processTerminator ?? new NodeDaemonProcessTerminator();
    this.observer = new DaemonRecordObserver(this.transport, this.processTerminator, this.now);
  }

  async ensureRunning(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    try {
      return await this.triggerAndWait(identity);
    } catch (error) {
      if (!(error instanceof DaemonChildExitError || error instanceof DaemonWarmupLostError)) {
        throw error;
      }
      return this.triggerAndWait(identity);
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
      heartbeatAt: this.now(),
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
                loadDurationMs: (record.readyAt ?? this.now()) - record.startedAt,
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
            firstObservedAt: this.now(),
          };
          await this.pause();
          continue;
        }
        if (this.now() - missingOwner.firstObservedAt <= DAEMON_STARTUP_TIMEOUT_MS) {
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
    const startedAt = this.now();
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
      const daemonOwner = this.registry.startupOwner(identity);
      if (
        !transferred &&
        !(
          daemonOwner?.identityKey === identity.identityKey &&
          daemonOwner.instanceId === instanceId &&
          daemonOwner.processToken === processToken &&
          daemonOwner.ownerKind === "daemon" &&
          daemonOwner.ownerPid === daemonProcess.pid
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
      const record = this.registry.readStoredInstance(identity, instanceId);
      if (record?.state === "starting" && record.processToken === processToken) {
        this.cleanupLaunchedProcess(identity, instanceId, processToken);
      }
    });
  }

  private cleanupLaunchedProcess(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): void {
    const record = this.registry.readStoredInstance(identity, instanceId);
    if (record?.processToken === processToken) {
      if (record.pid > 0) {
        this.registry.removeStartupLockIfProcess(identity, record);
      } else {
        const owner = this.registry.startupOwner(identity);
        if (owner?.instanceId === instanceId && owner.processToken === processToken) {
          this.registry.removeStartupLockIfOwner(identity, owner);
        }
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
    const record = this.registry.readStoredInstance(identity, owner.instanceId);
    if (
      record !== undefined &&
      ((owner.processToken.length > 0 && record.processToken !== owner.processToken) ||
        (owner.ownerKind === "daemon" && record.pid !== owner.ownerPid))
    ) {
      return false;
    }
    if (!this.registry.removeStartupLockIfOwner(identity, owner)) return false;
    if (record !== undefined) {
      this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
    }
    return true;
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
    const waitStartedAt = this.now();
    while (this.now() - waitStartedAt <= this.terminationTimeoutMs) {
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
    const response = await this.transport.request(record.endpoint, {
      kind: "execute",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: record.instanceId,
      processToken: record.processToken,
      requestId: randomUUID(),
      request: {
        argv: ["--version"],
        cwd: record.workspaceRoot,
        telemetryEnabled: false,
      },
    });
    if (response.kind !== "result" || response.result.exitCode !== 0) {
      throw new Error("Daemon execution readiness probe failed");
    }
  }

  private alreadyRunning(record: DaemonRecord): DaemonStartResult {
    return {
      status: "already-running",
      workspaceRoot: record.workspaceRoot,
      pid: record.pid,
      uptimeMs: Math.max(0, this.now() - record.startedAt),
    };
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
}
