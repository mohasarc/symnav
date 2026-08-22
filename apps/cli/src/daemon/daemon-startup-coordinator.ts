import { randomUUID } from "node:crypto";
import {
  DaemonProcessTerminationError,
  NodeDaemonProcessTerminator,
  type DaemonProcess,
  type DaemonProcessLauncher,
  type DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import type { DaemonRecord, DaemonStartResult } from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import type { DaemonRegistry, StartupOwner } from "./daemon-registry.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";

interface DaemonStartupCoordinatorOptions {
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly instanceId?: () => string;
  readonly processTerminator?: DaemonProcessTerminator;
  readonly heartbeatIntervalMs?: number;
}

export class DaemonStartupCoordinator {
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly nextInstanceId: () => string;
  private readonly processTerminator: DaemonProcessTerminator;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly launcher: DaemonProcessLauncher,
    private readonly transport: LocalDaemonTransport,
    options: DaemonStartupCoordinatorOptions = {},
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 20;
    this.now = options.now ?? Date.now;
    this.nextInstanceId = options.instanceId ?? randomUUID;
    this.processTerminator = options.processTerminator ?? new NodeDaemonProcessTerminator();
  }

  async ensureRunning(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    const readyRecord = await this.validatedReadyRecord(identity);
    if (readyRecord?.symnavVersion === this.launcher.symnavVersion) {
      return this.alreadyRunning(readyRecord);
    }

    const instanceId = this.nextInstanceId();
    const lease = this.registry.acquireStartup(identity, instanceId);
    if (lease === undefined) return this.waitForWinner(identity);

    try {
      const currentRecord = await this.validatedReadyRecord(identity);
      if (currentRecord?.symnavVersion === this.launcher.symnavVersion) {
        return this.alreadyRunning(currentRecord);
      }
      const storedRecord = this.registry.readStored(identity);
      if (storedRecord !== undefined) await this.replaceStoredRecord(identity, storedRecord);
      return await this.launchAndWait(identity, instanceId);
    } finally {
      lease.release();
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
    let daemonProcess: DaemonProcess;
    try {
      daemonProcess = await this.launcher.launch(identity, instanceId, processToken);
    } catch (error) {
      this.registry.removeIfInstance(identity, instanceId);
      throw error;
    }
    try {
      if (!this.registry.isStartupOwner(identity, instanceId)) {
        throw new Error("Daemon startup ownership changed after process launch");
      }
      this.registry.write({ ...startingRecord, pid: daemonProcess.pid });
      const ready = await this.waitForReady(identity, instanceId, startedAt);
      return {
        status: "ready",
        workspaceRoot: ready.workspaceRoot,
        fileCount: ready.fileCount ?? 0,
        loadDurationMs: (ready.readyAt ?? this.now()) - ready.startedAt,
      };
    } catch (error) {
      try {
        await daemonProcess.terminate();
      } catch (terminationError) {
        if (terminationError instanceof DaemonProcessTerminationError) throw terminationError;
        throw new DaemonProcessTerminationError(String(terminationError));
      }
      this.registry.removeIfInstance(identity, instanceId);
      throw error;
    }
  }

  private async waitForWinner(identity: DaemonWorkspaceIdentity): Promise<DaemonStartResult> {
    const waitStartedAt = this.now();
    while (this.now() - waitStartedAt <= this.startupTimeoutMs) {
      const record = await this.validatedReadyRecord(identity);
      if (record?.symnavVersion === this.launcher.symnavVersion) {
        return this.alreadyRunning(record);
      }
      const owner = this.registry.startupOwner(identity);
      if (owner === undefined) return this.ensureRunning(identity);
      if (!this.processTerminator.isAlive(owner.ownerPid)) {
        this.cleanupAbandonedStartup(identity, owner);
        return this.ensureRunning(identity);
      }
      await this.pause();
    }
    const owner = this.registry.startupOwner(identity);
    if (owner !== undefined) this.cleanupAbandonedStartup(identity, owner);
    throw new Error("Daemon startup timed out while waiting for another process");
  }

  private cleanupAbandonedStartup(
    identity: DaemonWorkspaceIdentity,
    owner: StartupOwner,
  ): void {
    this.registry.removeIfInstance(identity, owner.instanceId);
    this.registry.removeStartupLockIfInstance(identity, owner.instanceId);
  }

  private async waitForReady(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    waitStartedAt: number,
  ): Promise<DaemonRecord> {
    while (this.now() - waitStartedAt <= this.startupTimeoutMs) {
      const record = this.registry.readInstance(identity, instanceId);
      if (record?.state === "ready") {
        const validated = await this.validatedReadyRecord(identity);
        if (validated?.instanceId === instanceId) {
          await this.probeExecution(validated);
          return validated;
        }
      }
      await this.pause();
    }
    throw new Error("Daemon startup timed out before readiness probe completed");
  }

  private async validatedReadyRecord(
    identity: DaemonWorkspaceIdentity,
  ): Promise<DaemonRecord | undefined> {
    const record = this.registry.read(identity);
    if (record?.state !== "ready") return undefined;
    try {
      const response = await this.transport.request(record.endpoint, {
        kind: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: record.instanceId,
      });
      if (response.kind !== "pong" || response.symnavVersion !== record.symnavVersion) {
        return undefined;
      }
      return record;
    } catch {
      return undefined;
    }
  }

  private async replaceStoredRecord(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
  ): Promise<void> {
    if (await this.identifiesRecordedProcess(record)) {
      await this.transport.request(record.endpoint, {
        kind: "terminate",
        instanceId: record.instanceId,
        processToken: record.processToken,
      });
      await this.waitForProcessEndpointRelease(record);
    }
    this.registry.removeIfInstance(identity, record.instanceId);
  }

  private async waitForProcessEndpointRelease(record: DaemonRecord): Promise<void> {
    const waitStartedAt = this.now();
    while (this.now() - waitStartedAt <= this.startupTimeoutMs) {
      if (!(await this.identifiesRecordedProcess(record))) return;
      await this.pause();
    }
    throw new DaemonProcessTerminationError(
      `Daemon process ${record.pid} did not release its endpoint`,
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
