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
import type { DaemonRegistry, StartupOwner } from "./daemon-registry.js";
import { DaemonRecordObserver } from "./daemon-record-observer.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

interface DaemonStartupCoordinatorOptions {
  readonly startupTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly instanceId?: () => string;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly heartbeatIntervalMs?: number;
}

const STARTUP_HEARTBEAT_INTERVAL_MS = 100;
const DAEMON_TERMINATION_TIMEOUT_MS = 5 * 60_000;

class DaemonStartupWaitTimeoutError extends Error {}

class DaemonChildExitError extends Error {
  constructor(readonly exit: DaemonProcessExit) {
    super(
      exit.cause === "spawn-error"
        ? `Daemon child failed after spawn (${exit.errorName ?? "Error"})`
        : `Daemon child exited before readiness (code ${String(exit.code)}, signal ${String(exit.signal)})`,
    );
  }
}

class DaemonOwnedButUnresponsiveError extends Error {}

export class DaemonStartupCoordinator {
  private readonly startupTimeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly nextInstanceId: () => string;
  private readonly processTerminator: DaemonProcessTerminator;
  private readonly heartbeatIntervalMs: number;
  private readonly observer: DaemonRecordObserver;

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
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? STARTUP_HEARTBEAT_INTERVAL_MS;
    this.observer = new DaemonRecordObserver(this.transport, this.processTerminator, this.now);
  }

  async ensureRunning(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    try {
      return await this.ensureRunningOnce(identity);
    } catch (error) {
      if (!(error instanceof DaemonChildExitError)) throw error;
      return this.ensureRunningOnce(identity);
    }
  }

  private async ensureRunningOnce(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    const readyRecord = await this.validatedReadyRecord(identity);
    if (readyRecord?.symnavVersion === this.launcher.symnavVersion) {
      return this.alreadyRunning(readyRecord);
    }

    const instanceId = this.nextInstanceId();
    const lease = this.registry.acquireStartup(identity, instanceId);
    if (lease === undefined) return this.waitForWinner(identity);
    const heartbeat = setInterval(
      () => this.registry.refreshStartupOwner(identity, instanceId),
      this.heartbeatIntervalMs,
    );
    heartbeat.unref?.();

    let releaseLease = true;
    try {
      const currentRecord = await this.validatedReadyRecord(identity);
      if (currentRecord?.symnavVersion === this.launcher.symnavVersion) {
        return this.alreadyRunning(currentRecord);
      }
      const storedRecord = this.registry.readStored(identity);
      if (storedRecord !== undefined) await this.replaceStoredRecord(identity, storedRecord);
      return await this.launchAndWait(identity, instanceId);
    } catch (error) {
      if (
        error instanceof DaemonProcessTerminationError ||
        error instanceof DaemonStartupWaitTimeoutError
      ) {
        releaseLease = false;
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (releaseLease) lease.release();
    }
  }

  private async launchAndWait(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
  ): Promise<DaemonStartResult> {
    const startedAt = this.now();
    const processToken = randomUUID();
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
      if (
        !this.registry.writeStartingIfStartupOwner(identity, {
          ...startingRecord,
          pid: daemonProcess.pid,
        })
      ) {
        throw new Error("Daemon startup ownership changed after process launch");
      }
      const ready = await this.waitForReady(identity, instanceId, startedAt, daemonProcess);
      return {
        status: "ready",
        workspaceRoot: ready.workspaceRoot,
        fileCount: ready.fileCount ?? 0,
        loadDurationMs: (ready.readyAt ?? this.now()) - ready.startedAt,
      };
    } catch (error) {
      if (error instanceof DaemonStartupWaitTimeoutError) throw error;
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

  private cleanupLaunchedProcess(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): void {
    const record = this.registry.readStoredInstance(identity, instanceId);
    if (record?.processToken === processToken) {
      this.registry.removeStartupLockIfProcess(identity, record);
    }
    this.registry.removeIfProcess(identity, instanceId, processToken);
  }

  private async waitForWinner(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    const waitStartedAt = this.now();
    while (this.now() - waitStartedAt <= this.startupTimeoutMs) {
      const record = await this.validatedReadyRecord(identity);
      if (record?.symnavVersion === this.launcher.symnavVersion) {
        return this.alreadyRunning(record);
      }
      const owner = this.registry.startupOwner(identity);
      if (owner === undefined) return this.ensureRunningOnce(identity);
      if (this.startupOwnerIsAbandoned(identity, owner)) {
        if (this.cleanupAbandonedStartup(identity, owner)) return this.ensureRunningOnce(identity);
      }
      await this.pause();
    }
    const owner = this.registry.startupOwner(identity);
    if (owner !== undefined && this.startupOwnerIsAbandoned(identity, owner)) {
      this.cleanupAbandonedStartup(identity, owner);
    }
    throw new Error("Daemon startup timed out while waiting for another process");
  }

  private cleanupAbandonedStartup(identity: DaemonWorkspaceIdentity, owner: StartupOwner): boolean {
    const record = this.registry.readStoredInstance(identity, owner.instanceId);
    if (
      record !== undefined &&
      owner.processToken !== undefined &&
      (record.processToken !== owner.processToken || record.pid !== owner.ownerPid)
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
    if (owner.processToken !== undefined) return !this.processTerminator.isAlive(owner.ownerPid);
    return (
      !this.processTerminator.isAlive(owner.ownerPid) ||
      !this.registry.startupOwnerIsWithinGrace(owner)
    );
  }

  private async waitForReady(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    waitStartedAt: number,
    daemonProcess: DaemonProcess,
  ): Promise<DaemonRecord> {
    while (this.now() - waitStartedAt <= this.startupTimeoutMs) {
      const record = this.registry.readInstance(identity, instanceId);
      if (record?.state === "ready") {
        const validated = await this.validatedChildRecord(identity);
        if (validated?.instanceId === instanceId) {
          await this.probeExecution(validated);
          return validated;
        }
      }
      const childExit = await Promise.race([
        this.pause().then(() => undefined),
        daemonProcess.exited,
      ]);
      if (childExit !== undefined) throw new DaemonChildExitError(childExit);
    }
    throw new DaemonStartupWaitTimeoutError(
      "Daemon startup wait ended before readiness; live daemon ownership was retained",
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
