import type { ProgramDependencies } from "../program-dependencies.js";
import type { CommandExecutionResult, CommandOutputRecord } from "../command-execution-result.js";
import {
  AcceptedRequestCorruptionError,
  AcceptedRequestLedger,
} from "./accepted-request-ledger.js";
import type {
  DaemonExecutionFailureCode,
  DaemonExecutionServerFrame,
  DaemonRecord,
  DaemonRequest,
  DaemonResponse,
  DaemonServerMessage,
  DaemonServer,
} from "./daemon-protocol.js";
import {
  CompletionSpoolCapacityError,
  CompletionSpoolReadError,
  DaemonCompletionSpoolStore,
  type CompletionSpool,
  type CompletionSpoolStorage,
} from "./completion-spool.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import { DAEMON_IDLE_TIMEOUT_MS, DaemonLifetime } from "./daemon-lifetime.js";
import { DaemonLogger } from "./daemon-logger.js";
import {
  DaemonNavigationWorkerExitedError,
  type DaemonNavigationWorker,
  NodeDaemonNavigationWorker,
} from "./daemon-navigation-worker.js";
import { DaemonResourcePolicy, DaemonResourceSupervisor } from "./daemon-resource-monitor.js";
import type { DaemonNavigationWorkerResponse } from "./daemon-navigation-worker-protocol.js";
import {
  DAEMON_STARTUP_TIMEOUT_MS,
  type DaemonRegistry,
  type DaemonStartupLease,
} from "./daemon-registry.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { DaemonServerSend, LocalDaemonTransport } from "./local-daemon-transport.js";
import { WorkspaceRequestQueue, type DaemonCommandName } from "./workspace-request-queue.js";

export interface WorkspaceDaemonOptions {
  readonly identity: DaemonWorkspaceIdentity;
  readonly instanceId: string;
  readonly processToken: string;
  readonly symnavVersion: string;
  readonly memoryCapBytes: number;
  readonly dependencies: ProgramDependencies;
  readonly registry: DaemonRegistry;
  readonly transport: LocalDaemonTransport;
  readonly navigationWorker?: DaemonNavigationWorker;
  readonly navigationWorkerFactory?: (generation: number) => DaemonNavigationWorker;
  readonly resourcePolicy?: DaemonResourcePolicy;
  readonly now?: () => number;
  readonly exit?: (code: number) => void;
  readonly idleTimeoutMs?: number;
  readonly resourceCheckIntervalMs?: number;
  readonly residentMemoryBytes?: () => number;
  readonly startupHeartbeatIntervalMs?: number;
  readonly completionSpoolLimits?: {
    readonly inlineBytes?: number;
    readonly maximumResultBytes?: number;
    readonly maximumAggregateBytes?: number;
  };
  readonly completionSpoolStorage?: CompletionSpoolStorage;
}

export interface DaemonWorkerGeneration {
  readonly id: number;
  readonly worker: DaemonNavigationWorker;
  readonly ready: Promise<DaemonNavigationWorkerResponse>;
}

export class WorkspaceDaemon {
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private readonly initialNavigationWorker: DaemonNavigationWorker;
  private readonly navigationWorkerFactory:
    | ((generation: number) => DaemonNavigationWorker)
    | undefined;
  private workerGeneration: DaemonWorkerGeneration | undefined;
  private readonly requestQueue: WorkspaceRequestQueue;
  private readonly logger: DaemonLogger;
  private readonly lifetime: DaemonLifetime;
  private readonly resourceSupervisor: DaemonResourceSupervisor;
  private readonly acceptedRequests: AcceptedRequestLedger;
  private readonly completionSpools: DaemonCompletionSpoolStore;
  private readonly acceptances = new Map<
    string,
    { readonly acceptedAt: number; readonly queuePosition: number }
  >();
  private server: DaemonServer | undefined;
  private startedAt = 0;
  private fileCount = 0;
  private lastNavigationAt: number | undefined;
  private workerReady = false;
  private shutdownStarted = false;
  private shutdownFailureCode: DaemonExecutionFailureCode | undefined;
  private shutdownOperation: Promise<void> | undefined;
  private forcedWorkerShutdown: Promise<void> | undefined;
  private readonly forceEscalated: Promise<void>;
  private resolveForceEscalated!: () => void;
  private readonly resourceInterruptedRequests = new Set<string>();

  constructor(private readonly options: WorkspaceDaemonOptions) {
    this.forceEscalated = new Promise((resolve) => {
      this.resolveForceEscalated = resolve;
    });
    this.now = options.now ?? Date.now;
    this.requestQueue = new WorkspaceRequestQueue(this.now);
    this.acceptedRequests = new AcceptedRequestLedger(this.now);
    this.completionSpools = new DaemonCompletionSpoolStore({
      directory: options.identity.spoolDirectory,
      workspaceKey: options.identity.workspaceKey,
      instanceId: options.instanceId,
      ...options.completionSpoolLimits,
      ...(options.completionSpoolStorage === undefined
        ? {}
        : { storage: options.completionSpoolStorage }),
    });
    this.logger = new DaemonLogger(options.identity.logPath, { now: this.now });
    const resourcePolicy =
      options.resourcePolicy ??
      DaemonResourcePolicy.fromSystemMemory(
        Math.max(options.memoryCapBytes * 2, 512 * 1024 * 1024),
      );
    this.navigationWorkerFactory =
      options.navigationWorkerFactory ??
      (options.navigationWorker === undefined
        ? (generation) =>
            new NodeDaemonNavigationWorker({
              generation,
              stateDirectory: options.identity.stateDirectory,
              resourceLimits: {
                maxOldGenerationSizeMb: resourcePolicy.record.workerMaxOldGenerationSizeMb,
              },
            })
        : undefined);
    this.initialNavigationWorker = options.navigationWorker ?? this.createNavigationWorker(1);
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.lifetime = new DaemonLifetime(
      { now: this.now },
      options.idleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS,
      () => this.drainAndShutdown("idle"),
    );
    this.resourceSupervisor = new DaemonResourceSupervisor({
      policy: resourcePolicy,
      generation: 1,
      ...(options.resourceCheckIntervalMs === undefined
        ? {}
        : { intervalMs: options.resourceCheckIntervalMs }),
      ...(options.residentMemoryBytes === undefined
        ? {}
        : { residentMemoryBytes: options.residentMemoryBytes }),
      spoolBytes: () => this.completionSpools.usage().rawBytes,
      releaseTransientResources: () => this.releaseTransientResources(),
      replaceWorker: () => this.replaceNavigationWorker(),
      drain: () => this.shutdown("resource", true),
    });
  }

  async start(): Promise<void> {
    this.logger.record({
      kind: "start",
      workspaceRoot: this.options.identity.workspaceRoot,
      instanceId: this.options.instanceId,
    });
    let startupLease: DaemonStartupLease | undefined;
    let startupHeartbeat: NodeJS.Timeout | undefined;
    try {
      const authorization = await this.waitForStartupAuthorization();
      startupLease = authorization.lease;
      const startingRecord = authorization.record;
      startupHeartbeat = setInterval(
        () => startupLease?.heartbeat(),
        this.options.startupHeartbeatIntervalMs ?? 100,
      );
      startupHeartbeat.unref();
      this.startedAt = startingRecord.startedAt;
      this.server = await this.options.transport.listen(
        this.options.identity.endpoint(this.options.instanceId),
        (request, send) => this.handle(request, send),
      );
      const generation = this.startWorkerGeneration(this.initialNavigationWorker);
      const response = await generation.ready;
      if (response.kind !== "ready") throw new Error("Navigation worker did not become ready");
      this.workerReady = true;
      this.fileCount = response.fileCount;
      this.logger.record({ kind: "freshness", ...response.refresh });
      const readyRecord: DaemonRecord = {
        schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        symnavVersion: this.options.symnavVersion,
        workspaceRoot: this.options.identity.workspaceRoot,
        workspaceKey: this.options.identity.workspaceKey,
        stateKey: this.options.identity.stateKey,
        identityKey: this.options.identity.identityKey,
        instanceId: this.options.instanceId,
        processToken: this.options.processToken,
        endpoint: this.options.identity.endpoint(this.options.instanceId),
        pid: process.pid,
        state: "ready",
        startedAt: startingRecord.startedAt,
        readyAt: this.now(),
        fileCount: response.fileCount,
        memoryCapBytes: this.options.memoryCapBytes,
      };
      if (!this.options.registry.writeIfStartupOwner(this.options.identity, readyRecord)) {
        throw new Error("Daemon startup ownership changed before readiness publication");
      }
      if (startupHeartbeat !== undefined) clearInterval(startupHeartbeat);
      startupHeartbeat = undefined;
      startupLease.release();
      this.logger.record({ kind: "ready", fileCount: response.fileCount });
      this.resourceSupervisor.start();
    } catch (error) {
      if (startupHeartbeat !== undefined) clearInterval(startupHeartbeat);
      await this.cleanupFailedStartup(startupLease);
      this.logger.record({
        kind: "failure",
        operation: "start",
        message: WorkspaceDaemon.errorMessage(error),
      });
      throw error;
    }
  }

  private async waitForStartupAuthorization(): Promise<{
    readonly lease: DaemonStartupLease;
    readonly record: DaemonRecord;
  }> {
    const deadline = this.now() + DAEMON_STARTUP_TIMEOUT_MS;
    while (this.now() <= deadline) {
      const record = this.options.registry.readInstance(
        this.options.identity,
        this.options.instanceId,
      );
      if (
        record?.state === "starting" &&
        (record.pid === 0 || record.pid === process.pid) &&
        record.processToken === this.options.processToken
      ) {
        const lease = this.options.registry.claimStartupForDaemon(
          this.options.identity,
          this.options.instanceId,
          this.options.processToken,
          process.pid,
        );
        if (lease === undefined) {
          await this.pause();
          continue;
        }
        this.options.registry.writeStartingIfStartupOwner(this.options.identity, {
          ...record,
          pid: process.pid,
        });
        const adoptedRecord = this.options.registry.readInstance(
          this.options.identity,
          this.options.instanceId,
        );
        if (adoptedRecord?.pid !== process.pid) {
          lease.release();
          await this.pause();
          continue;
        }
        if (
          this.options.registry.startupOwnerMatchesProcess(this.options.identity, adoptedRecord)
        ) {
          return { lease, record: adoptedRecord };
        }
        lease.release();
      }
      await this.pause();
    }
    throw new Error("Daemon process did not receive startup authorization");
  }

  private async cleanupFailedStartup(startupLease: DaemonStartupLease | undefined): Promise<void> {
    this.shutdownStarted = true;
    try {
      await (this.workerGeneration?.worker ?? this.initialNavigationWorker).terminate();
    } catch {}
    try {
      await this.server?.close();
    } catch {}
    startupLease?.release();
    this.options.registry.removeIfProcess(
      this.options.identity,
      this.options.instanceId,
      this.options.processToken,
    );
  }

  private async handle(
    request: DaemonRequest,
    send: DaemonServerSend,
  ): Promise<DaemonResponse | void> {
    if (request.kind === "identify") return this.identify(request);
    if (request.kind === "terminate" || request.kind === "kill") {
      return this.terminate(request);
    }
    if (
      request.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
      request.instanceId !== this.options.instanceId
    ) {
      throw new Error("Daemon request does not match protocol or instance");
    }
    if (request.kind === "ping") return this.pong();
    if (
      request.kind === "execute" ||
      request.kind === "execution-status" ||
      request.kind === "result-fetch" ||
      request.kind === "result-ack"
    ) {
      if (request.processToken !== this.options.processToken) {
        throw new Error("Daemon execution request does not match process instance");
      }
    }
    if (request.kind === "execute") return this.acceptExecution(request, send);
    if (request.kind === "result-fetch") {
      await this.deliverStoredCompletion(request.requestId, send, request.offset);
      return;
    }
    if (request.kind === "result-ack") {
      const spool = await this.completionSpools.open(request.requestId);
      if (spool === undefined) throw new Error("Accepted request completion is unavailable");
      if (spool.completedManifest?.transferId !== request.transferId) {
        throw new Error("Result acknowledgement does not match completion transfer");
      }
      await spool.acknowledge().catch((error) => {
        this.logger.record({
          kind: "failure",
          operation: "completion-cleanup",
          message: WorkspaceDaemon.errorMessage(error),
        });
      });
      this.acceptedRequests.acknowledge(request.requestId);
      return {
        kind: "result-acknowledged",
        instanceId: this.options.instanceId,
        processToken: this.options.processToken,
        requestId: request.requestId,
        transferId: request.transferId,
      };
    }
    if (request.kind === "execution-status") {
      return {
        kind: "execution-status",
        instanceId: this.options.instanceId,
        processToken: this.options.processToken,
        requestId: request.requestId,
        status: this.acceptedRequests.status(request.requestId),
      };
    }
    await this.requestQueue.drain();
    setTimeout(() => void this.shutdown("graceful"), 0);
    return { kind: "stopped", instanceId: this.options.instanceId };
  }

  private identify(request: Extract<DaemonRequest, { kind: "identify" }>): DaemonResponse {
    if (
      request.instanceId !== this.options.instanceId ||
      request.processToken !== this.options.processToken
    ) {
      throw new Error("Daemon identity request does not match process instance");
    }
    return {
      kind: "identity",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      pid: process.pid,
      startedAt: this.startedAt,
    };
  }

  private async terminate(
    request: Extract<DaemonRequest, { kind: "terminate" | "kill" }>,
  ): Promise<DaemonResponse> {
    if (
      request.instanceId !== this.options.instanceId ||
      request.processToken !== this.options.processToken
    ) {
      throw new Error("Daemon termination does not match process instance");
    }
    if (request.kind === "terminate") {
      await this.requestQueue.drain();
      setTimeout(() => void this.shutdown("graceful"), 0);
    } else {
      setTimeout(() => void this.shutdown("graceful", true), 0);
    }
    return {
      kind: request.kind === "terminate" ? "terminating" : "killing",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
    };
  }

  private pong(): DaemonResponse {
    const activity = this.requestQueue.snapshot;
    const active = activity.active;
    return {
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      symnavVersion: this.options.symnavVersion,
      state: this.workerReady ? (active === undefined ? "ready" : "busy") : "starting",
      startedAt: this.startedAt,
      fileCount: this.fileCount,
      memoryBytes: process.memoryUsage().rss,
      queued: activity.queued,
      ...(active === undefined
        ? {}
        : {
            currentCommand: active.command,
            currentCommandElapsedMs: Math.max(0, this.now() - active.startedAt),
          }),
      ...(this.lastNavigationAt === undefined ? {} : { lastNavigationAt: this.lastNavigationAt }),
    };
  }

  private async acceptExecution(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    send: DaemonServerSend,
  ): Promise<DaemonResponse | void> {
    void this.resourceSupervisor.sample("admission").catch((error) => {
      this.logger.record({
        kind: "failure",
        operation: "resource-sample",
        message: WorkspaceDaemon.errorMessage(error),
      });
    });
    if (!this.workerReady) return this.rejection(request, "not-ready", true);
    if (this.resourceSupervisor.snapshot.admissionPaused) {
      return this.rejection(request, "resource-pressure", true);
    }
    if (this.requestQueue.state !== "accepting") {
      return this.rejection(request, "draining", true);
    }
    const existing = this.acceptedRequests.entryFor(request.requestId);
    let entry;
    try {
      entry = this.acceptedRequests.accept(request.requestId, request.request);
    } catch (error) {
      if (error instanceof AcceptedRequestCorruptionError) {
        return this.rejection(request, "incompatible", false);
      }
      throw error;
    }
    if (entry.state.state === "queued") {
      this.acceptances.set(request.requestId, {
        acceptedAt: entry.state.acceptedAt,
        queuePosition: entry.state.queuePosition,
      });
      if (existing === undefined) {
        this.logger.record({
          kind: "acceptance",
          requestId: request.requestId,
          queuePosition: entry.state.queuePosition,
        });
      }
    }
    const acceptance = this.acceptances.get(request.requestId);
    if (acceptance === undefined) throw new Error("Accepted request is missing admission metadata");
    if (existing === undefined) {
      this.lastNavigationAt = this.now();
      this.lifetime.navigationAccepted();
      void this.executeAccepted(request);
    }
    await this.deliver(send, {
      kind: "accepted",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId: request.requestId,
      ...acceptance,
    });
    if (entry.state.state === "completed") {
      await this.deliverStoredCompletion(request.requestId, send);
      return;
    }
    if (entry.state.state === "failed") {
      await this.deliver(send, this.failedFrame(request.requestId, entry.state.code));
      return;
    }
    let unsubscribe: (() => void) | undefined;
    unsubscribe = this.acceptedRequests.subscribe(request.requestId, (updated) => {
      if (updated.state.state === "completed") {
        void this.deliverStoredCompletion(request.requestId, send).catch((error) =>
          this.recordDeliveryFailure(error),
        );
        unsubscribe?.();
      } else if (updated.state.state === "failed") {
        void this.deliver(send, this.failedFrame(request.requestId, updated.state.code)).catch(
          (error) => this.recordDeliveryFailure(error),
        );
        unsubscribe?.();
      }
    });
  }

  private async executeAccepted(
    request: Extract<DaemonRequest, { kind: "execute" }>,
  ): Promise<void> {
    const requestStartedAt = this.now();
    let spool: CompletionSpool | undefined;
    try {
      const result = await this.requestQueue.enqueue(
        {
          requestId: request.requestId,
          command: WorkspaceDaemon.commandName(request.request.argv),
          acceptedAt: this.now(),
        },
        async () => {
          spool = await this.completionSpools.create(request.requestId);
          this.acceptedRequests.markRunning(request.requestId, this.now());
          const generation = this.workerGeneration;
          if (generation === undefined) throw new Error("Navigation worker is unavailable");
          const ready = await generation.ready;
          if (ready.kind !== "ready") throw new Error("Navigation worker did not become ready");
          const response = await generation.worker.execute(
            request.requestId,
            request.request,
            spool,
          );
          if (response.kind !== "result" || response.requestId !== request.requestId) {
            throw new Error("Navigation worker returned an uncorrelated result");
          }
          this.logger.record({ kind: "freshness", ...response.refresh });
          return response.result;
        },
      );
      if (spool === undefined) throw new Error("Completion spool was not created");
      await spool.finish(result.exitCode);
      await this.recordCompletion(request, requestStartedAt, result);
      this.acceptedRequests.complete(request.requestId, request.requestId, this.now());
    } catch (error) {
      this.logger.record({
        kind: "failure",
        operation: "request",
        message: WorkspaceDaemon.errorMessage(error),
      });
      const code =
        (this.resourceInterruptedRequests.delete(request.requestId)
          ? "controlled-resource"
          : undefined) ??
        this.shutdownFailureCode ??
        (error instanceof CompletionSpoolCapacityError
          ? "response-capacity"
          : error instanceof DaemonNavigationWorkerExitedError
            ? "worker-exit"
            : this.shutdownStarted
              ? "stopping"
              : "internal");
      await spool?.dispose().catch((cleanupError) => {
        this.logger.record({
          kind: "failure",
          operation: "completion-cleanup",
          message: WorkspaceDaemon.errorMessage(cleanupError),
        });
      });
      this.acceptedRequests.fail(request.requestId, code, this.now());
    } finally {
      await this.resourceSupervisor.sample("turn-complete").catch((error) => {
        this.logger.record({
          kind: "failure",
          operation: "resource-sample",
          message: WorkspaceDaemon.errorMessage(error),
        });
      });
      if (this.requestQueue.isIdle) this.lifetime.queueBecameIdle();
    }
  }

  private async recordCompletion(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    requestStartedAt: number,
    result: { readonly exitCode: number },
  ): Promise<void> {
    this.logger.record({
      kind: "request",
      command: WorkspaceDaemon.commandName(request.request.argv),
      durationMs: Math.max(0, this.now() - requestStartedAt),
      exitCode: result.exitCode,
    });
    if (!(await this.options.dependencies.fs.exists(this.options.identity.workspaceRoot))) {
      setTimeout(() => void this.shutdown("workspace-deleted", true), 0);
    }
  }

  private rejection(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    code: "not-ready" | "draining" | "resource-pressure" | "incompatible",
    retrySafe: boolean,
  ): DaemonExecutionServerFrame {
    return {
      kind: "rejected",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId: request.requestId,
      code,
      retrySafe,
    };
  }

  private failedFrame(
    requestId: string,
    code: DaemonExecutionFailureCode,
  ): DaemonExecutionServerFrame {
    return {
      kind: "execution-failed",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId,
      code,
    };
  }

  private deliver(send: DaemonServerSend, frame: DaemonServerMessage): Promise<void> {
    return send(frame);
  }

  private async deliverStoredCompletion(
    requestId: string,
    send: DaemonServerSend,
    offset = 0,
  ): Promise<void> {
    const spool = await this.completionSpools.open(requestId);
    if (spool === undefined) throw new Error("Accepted request result is missing");
    try {
      await this.deliverCompletion(requestId, spool, offset, send);
    } catch (error) {
      if (!(error instanceof CompletionSpoolReadError)) throw error;
      this.logger.record({
        kind: "failure",
        operation: "completion-delivery",
        message: WorkspaceDaemon.errorMessage(error),
      });
      await spool.dispose().catch((cleanupError) => {
        this.logger.record({
          kind: "failure",
          operation: "completion-cleanup",
          message: WorkspaceDaemon.errorMessage(cleanupError),
        });
      });
      this.acceptedRequests.invalidateCompletion(requestId, "internal", this.now());
      await this.deliver(send, this.failedFrame(requestId, "internal"));
    }
  }

  private async deliverCompletion(
    requestId: string,
    spool: CompletionSpool,
    offset: number,
    send: DaemonServerSend,
  ): Promise<void> {
    const completedManifest = spool.completedManifest;
    if (completedManifest === undefined) throw new Error("Completion manifest is missing");
    await this.deliver(send, {
      kind: "result-manifest",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId,
      manifest: completedManifest,
    });
    for await (const record of spool.read(offset)) {
      await this.deliver(send, {
        transferId: completedManifest.transferId,
        requestId,
        offset: record.sequence,
        sequence: record.sequence,
        stream: record.stream,
        bytes: record.bytes,
      });
    }
    await this.deliver(send, {
      kind: "result-end",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId,
      transferId: completedManifest.transferId,
      rawBytes: completedManifest.rawBytes,
      recordCount: completedManifest.recordCount,
      sha256: completedManifest.sha256,
    });
  }

  private recordDeliveryFailure(error: unknown): void {
    this.logger.record({
      kind: "failure",
      operation: "completion-delivery",
      message: WorkspaceDaemon.errorMessage(error),
    });
  }

  private async drainAndShutdown(reason: "idle"): Promise<void> {
    await this.requestQueue.drain();
    await this.shutdown(reason);
  }

  private async shutdown(
    reason: "graceful" | "idle" | "resource" | "workspace-deleted",
    force = false,
  ): Promise<void> {
    this.shutdownFailureCode ??= reason === "resource" ? "controlled-resource" : "stopping";
    if (force) this.forceWorkerShutdown();
    if (this.shutdownOperation !== undefined) return this.shutdownOperation;
    this.shutdownStarted = true;
    this.shutdownOperation = this.completeShutdown(reason, force);
    return this.shutdownOperation;
  }

  private async completeShutdown(
    reason: "graceful" | "idle" | "resource" | "workspace-deleted",
    force: boolean,
  ): Promise<void> {
    this.lifetime.stop();
    this.resourceSupervisor.stop();
    if (force) await this.forceWorkerShutdown();
    else await this.gracefullyShutdownWorker();
    this.logger.record({ kind: "stop", reason });
    try {
      await this.server?.close();
    } catch (error) {
      this.logger.record({
        kind: "failure",
        operation: "transport-close",
        message: WorkspaceDaemon.errorMessage(error),
      });
    }
    await this.completionSpools.cleanupInstance(this.options.instanceId).catch((error) => {
      this.logger.record({
        kind: "failure",
        operation: "completion-cleanup",
        message: WorkspaceDaemon.errorMessage(error),
      });
    });
    this.exit(0);
  }

  private async gracefullyShutdownWorker(): Promise<void> {
    await this.requestQueue.drain();
    const gracefulClose = this.currentNavigationWorker().drainAndClose();
    await Promise.race([gracefulClose, this.forceEscalated.then(() => this.forceWorkerShutdown())]);
  }

  private forceWorkerShutdown(): Promise<void> {
    if (this.forcedWorkerShutdown !== undefined) return this.forcedWorkerShutdown;
    this.requestQueue.close();
    this.forcedWorkerShutdown = this.currentNavigationWorker()
      .terminate()
      .then(() => this.requestQueue.drain());
    this.resolveForceEscalated();
    return this.forcedWorkerShutdown;
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
  }

  private createNavigationWorker(generation: number): DaemonNavigationWorker {
    const worker = this.navigationWorkerFactory?.(generation);
    if (worker === undefined) throw new Error("Navigation worker replacement is unavailable");
    if (worker.generation !== generation) {
      throw new Error("Navigation worker factory returned the wrong generation");
    }
    return worker;
  }

  private startWorkerGeneration(worker: DaemonNavigationWorker): DaemonWorkerGeneration {
    const generation: DaemonWorkerGeneration = {
      id: worker.generation,
      worker,
      ready: worker.start(this.options.identity.workspaceRoot),
    };
    this.workerGeneration = generation;
    void worker.exited.then((exit) => this.observeWorkerExit(exit));
    return generation;
  }

  private observeWorkerExit(
    exit: import("./daemon-navigation-worker.js").DaemonNavigationWorkerExit,
  ): void {
    if (this.shutdownStarted) return;
    this.logger.record({
      kind: "failure",
      operation: "worker-exit",
      message: `${exit.cause}${exit.errorName === undefined ? "" : ` (${exit.errorName})`}`,
    });
    void this.resourceSupervisor.workerExited(exit).catch((error) => {
      this.logger.record({
        kind: "failure",
        operation: "worker-replacement",
        message: WorkspaceDaemon.errorMessage(error),
      });
    });
  }

  private async replaceNavigationWorker(): Promise<number> {
    const current = this.workerGeneration;
    if (current === undefined) throw new Error("Navigation worker generation is unavailable");
    const activeRequest = this.requestQueue.snapshot.active;
    if (activeRequest !== undefined) this.resourceInterruptedRequests.add(activeRequest.requestId);
    const nextWorker = this.createNavigationWorker(current.id + 1);
    this.workerReady = false;
    const next = this.startWorkerGeneration(nextWorker);
    await current.worker.terminate().catch(() => undefined);
    const response = await next.ready;
    if (response.kind !== "ready") throw new Error("Replacement navigation worker did not start");
    this.fileCount = response.fileCount;
    this.workerReady = true;
    this.logger.record({ kind: "freshness", ...response.refresh });
    return next.id;
  }

  private async releaseTransientResources(): Promise<void> {
    const generation = this.workerGeneration;
    if (generation === undefined) return;
    const response = await generation.worker.releaseTransientResources();
    if (response.kind !== "heap") throw new Error("Navigation worker did not report heap usage");
    this.resourceSupervisor.workerHeapReported(
      response.generation,
      response.usedHeapBytes,
      response.heapLimitBytes,
    );
  }

  private currentNavigationWorker(): DaemonNavigationWorker {
    return this.workerGeneration?.worker ?? this.initialNavigationWorker;
  }

  private static commandName(argv: readonly string[]): DaemonCommandName {
    const commands: readonly DaemonCommandName[] = [
      "overview",
      "resolve",
      "def",
      "refs",
      "context",
      "graph",
      "stats",
    ];
    const command = argv.find((argument): argument is DaemonCommandName =>
      commands.includes(argument as DaemonCommandName),
    );
    if (command !== undefined) return command;
    if (argv.includes("--version") || argv.includes("-v")) return "version";
    if (argv.includes("--help") || argv.includes("-h")) return "help";
    return "unknown";
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
