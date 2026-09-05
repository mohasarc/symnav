import { access } from "node:fs/promises";
import {
  DaemonAdmissionPolicy,
  DaemonAdmissionRejections,
  DaemonExecutionFailures,
  type DaemonAdmissionDecision,
  type DaemonExecuteRejectionCode,
  type DaemonExecutionFailureCode,
  type DaemonExecutorModuleUrl,
  type DaemonPolicy,
  type DaemonPolicyValues,
} from "@symnav/daemon";
import { AcceptedRequestLedger } from "./accepted-request-ledger.js";
import { DaemonActivityProjector } from "./daemon-activity-projector.js";
import type {
  DaemonDeliveryOutcome,
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
import { DaemonLifetime } from "./daemon-lifetime.js";
import { DaemonLogger } from "./daemon-logger.js";
import { NodeDaemonClock, type DaemonClock } from "./daemon-clock.js";
import { DaemonOperationObserver, type DaemonOperationTrace } from "./daemon-operation-observer.js";
import {
  DaemonNavigationWorkerExitedError,
  type DaemonNavigationWorker,
  NodeDaemonNavigationWorker,
} from "./daemon-navigation-worker.js";
import { DaemonWorkerGenerationManager } from "./daemon-worker-generation-manager.js";
import {
  DaemonResourceSupervisor,
  type DaemonWorkerReplacementCause,
} from "./daemon-resource-monitor.js";
import type { DaemonRegistry, DaemonStartupLease } from "./daemon-registry.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { DaemonRequestServer, DaemonServerSend } from "./daemon-transport.js";
import { WorkspaceRequestQueue } from "./workspace-request-queue.js";

export interface WorkspaceDaemonOptions {
  readonly identity: DaemonWorkspaceIdentity;
  readonly instanceId: string;
  readonly processToken: string;
  readonly symnavVersion: string;
  readonly executorModuleUrl?: DaemonExecutorModuleUrl;
  readonly policy: DaemonPolicy;
  readonly dependencies?: {
    readonly fs: { exists(path: string): Promise<boolean> };
  };
  readonly registry: DaemonRegistry;
  readonly transport: DaemonRequestServer;
  readonly navigationWorker?: DaemonNavigationWorker;
  readonly navigationWorkerFactory?: (generation: number) => DaemonNavigationWorker;
  readonly now?: () => number;
  readonly clock?: DaemonClock;
  readonly exit?: (code: number) => void;
  readonly residentMemoryBytes?: () => number;
  readonly completionSpoolStorage?: CompletionSpoolStorage;
  readonly logger?: DaemonLogger;
}

export class WorkspaceDaemon {
  private readonly now: () => number;
  private readonly clock: DaemonClock;
  private readonly exit: (code: number) => void;
  private readonly workerManager: DaemonWorkerGenerationManager;
  private readonly requestQueue: WorkspaceRequestQueue;
  private readonly logger: DaemonLogger;
  private readonly lifetime: DaemonLifetime;
  private readonly resourceSupervisor: DaemonResourceSupervisor;
  private readonly resourcePolicy: DaemonPolicyValues["resources"];
  private readonly policy: DaemonPolicy;
  private readonly operationObserver: DaemonOperationObserver;
  private readonly acceptedRequests: AcceptedRequestLedger;
  private readonly admissionPolicy = new DaemonAdmissionPolicy();
  private readonly completionSpools: DaemonCompletionSpoolStore;
  private readonly acceptances = new Map<
    string,
    { readonly acceptedAt: number; readonly queuePosition: number }
  >();
  private server: DaemonServer | undefined;
  private startedAt = 0;
  private readonly startedMonotonicAt: number;
  private lastNavigationAt: number | undefined;
  private lastCompletedMonotonicAt: number | undefined;
  private shutdownStarted = false;
  private shutdownFailureCode: "stopping" | "controlled-resource" | undefined;
  private shutdownOperation: Promise<void> | undefined;
  private forcedWorkerShutdown: Promise<void> | undefined;
  private readonly forceEscalated: Promise<void>;
  private resolveForceEscalated!: () => void;
  private readonly resourceInterruptedRequests = new Set<string>();
  private readonly completionDeliveries = new Map<string, Promise<void>>();
  private readonly operationTraces = new Map<string, DaemonOperationTrace>();
  private readonly operationTraceExpirations = new Map<string, NodeJS.Timeout>();
  private readonly operationTraceConnections = new Map<string, number>();

  constructor(private readonly options: WorkspaceDaemonOptions) {
    const policy = options.policy;
    this.policy = policy;
    this.forceEscalated = new Promise((resolve) => {
      this.resolveForceEscalated = resolve;
    });
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? new NodeDaemonClock();
    this.startedMonotonicAt = this.clock.monotonicNowMs();
    this.requestQueue = new WorkspaceRequestQueue(() => this.clock.monotonicNowMs());
    this.acceptedRequests = new AcceptedRequestLedger(this.now);
    this.completionSpools = new DaemonCompletionSpoolStore({
      directory: options.identity.spoolDirectory,
      workspaceKey: options.identity.workspaceKey,
      instanceId: options.instanceId,
      policy: policy.values.output,
      ...(options.completionSpoolStorage === undefined
        ? {}
        : { storage: options.completionSpoolStorage }),
    });
    this.logger =
      options.logger ??
      new DaemonLogger(options.identity, options.instanceId, this.clock, {
        policy: policy.values.diagnostics,
      });
    const resourcePolicy = policy.values.resources;
    this.resourcePolicy = resourcePolicy;
    const navigationWorkerFactory =
      options.navigationWorkerFactory ??
      (options.navigationWorker === undefined
        ? (generation) =>
            new NodeDaemonNavigationWorker({
              generation,
              configuration: {
                stateDirectory: options.identity.stateDirectory,
                productVersion: options.symnavVersion,
                executorModuleUrl:
                  options.executorModuleUrl ?? "file:///missing/symnav-daemon-executor.js",
                policy: policy.toSerialized(),
              },
              resourceLimits: {
                maxOldGenerationSizeMb: resourcePolicy.workerMaxOldGenerationSizeMiB,
              },
            })
        : undefined);
    const createNavigationWorker = (generation: number): DaemonNavigationWorker => {
      const worker = navigationWorkerFactory?.(generation);
      if (worker === undefined) throw new Error("Navigation worker replacement is unavailable");
      if (worker.generation !== generation) {
        throw new Error("Navigation worker factory returned the wrong generation");
      }
      return worker;
    };
    const initialNavigationWorker = options.navigationWorker ?? createNavigationWorker(1);
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.lifetime = new DaemonLifetime({ now: this.now }, policy.values.shutdown, () =>
      this.drainAndShutdown("idle"),
    );
    this.workerManager = new DaemonWorkerGenerationManager({
      workspaceRoot: options.identity.workspaceRoot,
      initialWorker: initialNavigationWorker,
      createWorker: createNavigationWorker,
      exitRecovery: { recover: (workerExit) => this.recoverWorkerExit(workerExit) },
      onActiveResourceInterruption: (cause) => this.markActiveResourceInterruption(cause),
      onDiagnostic: (diagnostic) => this.operationObserver.worker(diagnostic),
    });
    this.resourceSupervisor = new DaemonResourceSupervisor({
      policy: resourcePolicy,
      generation: this.workerManager.snapshot.generation,
      ...(options.residentMemoryBytes === undefined
        ? {}
        : { residentMemoryBytes: options.residentMemoryBytes }),
      spoolBytes: () => this.completionSpools.usage().rawBytes,
      scheduleAtTurnBoundary: (operation) => this.requestQueue.scheduleAtTurnBoundary(operation),
      releaseTransientResources: async () => {
        const response = await this.workerManager.releaseTransientResources();
        this.resourceSupervisor.workerHeapReported(
          response.generation,
          response.usedHeapBytes,
          response.heapLimitBytes,
        );
      },
      replaceWorker: async (cause) => {
        const response = await this.workerManager.replace(cause);
        this.logger.record({ kind: "freshness", ...response.refresh });
        return response.generation;
      },
      drain: () => this.initiateResourceDrain(),
    });
    this.operationObserver = new DaemonOperationObserver(
      this.logger,
      this.clock,
      this.resourceSupervisor,
    );
  }

  async start(): Promise<void> {
    this.logger.record({ kind: "start" });
    let startupLease: DaemonStartupLease | undefined;
    let startupHeartbeat: NodeJS.Timeout | undefined;
    try {
      const authorization = await this.waitForStartupAuthorization();
      startupLease = authorization.lease;
      const startingRecord = authorization.record;
      startupHeartbeat = setInterval(
        () => startupLease?.heartbeat(),
        this.policy.values.startup.heartbeatIntervalMs,
      );
      startupHeartbeat.unref();
      this.startedAt = startingRecord.startedAt;
      this.server = await this.options.transport.listen(
        this.options.identity.endpoint(this.options.instanceId),
        (request, send) => this.handle(request, send),
      );
      const response = await this.workerManager.start();
      this.operationObserver.startup({
        kind: "startup-completed",
        workerGeneration: response.generation,
        fileCount: response.fileCount,
        ...response.startupDurations,
      });
      this.logger.record({ kind: "freshness", ...response.refresh });
      await this.resourceSupervisor.sample("warmup");
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
        memoryCapBytes: this.resourcePolicy.hardProcessRssBytes,
      };
      if (!this.options.registry.writeIfStartupOwner(this.options.identity, readyRecord)) {
        throw new Error("Daemon startup ownership changed before readiness publication");
      }
      if (startupHeartbeat !== undefined) clearInterval(startupHeartbeat);
      startupHeartbeat = undefined;
      startupLease.release();
      this.logger.record({ kind: "ready", fileCount: response.fileCount });
      this.resourceSupervisor.start();
      await this.logger.flush();
    } catch (error) {
      if (startupHeartbeat !== undefined) clearInterval(startupHeartbeat);
      await this.cleanupFailedStartup(startupLease);
      this.logger.record({
        kind: "failure",
        operation: "start",
        failureCode: "operation-failed",
        errorName: DaemonLogger.errorName(error),
      });
      await this.logger.flush();
      throw error;
    }
  }

  private async waitForStartupAuthorization(): Promise<{
    readonly lease: DaemonStartupLease;
    readonly record: DaemonRecord;
  }> {
    const deadline = this.now() + this.policy.values.startup.coordinationGraceMs;
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
      await this.workerManager.terminate();
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
    if (request.kind === "execute") return this.acceptExecution(request, send);
    if (
      request.kind === "execution-status" ||
      request.kind === "result-fetch" ||
      request.kind === "result-ack"
    ) {
      if (request.processToken !== this.options.processToken) {
        throw new Error("Daemon execution request does not match process instance");
      }
    }
    if (request.kind === "result-fetch") {
      let disconnectTraceConnection: (() => void) | undefined;
      if (this.acceptedRequests.entryFor(request.requestId)?.state.state === "completed") {
        const traceWasDisconnected = !this.operationTraceConnections.has(request.requestId);
        disconnectTraceConnection = this.attachOperationTraceConnection(request.requestId, send);
        if (traceWasDisconnected) this.reattachOperationTrace(request.requestId);
      }
      try {
        await this.deliverStoredCompletion(request.requestId, send, request.offset);
      } catch (error) {
        disconnectTraceConnection?.();
        throw error;
      }
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
          failureCode: "internal",
          errorName: DaemonLogger.errorName(error),
        });
      });
      this.acceptedRequests.acknowledge(request.requestId);
      this.completeOperationTrace(request.requestId, "delivered");
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
    this.beginGracefulShutdown();
    await this.requestQueue.drain();
    await this.waitForCompletionAcknowledgements();
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
    this.beginGracefulShutdown();
    if (request.kind === "terminate") {
      await this.requestQueue.drain();
      await this.waitForCompletionAcknowledgements();
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
    const queue = this.requestQueue.snapshot;
    const resources = this.resourceSupervisor.snapshot;
    const worker = this.workerManager.snapshot;
    return DaemonActivityProjector.project({
      nowMonotonicMs: this.clock.monotonicNowMs(),
      pid: process.pid,
      processRssBytes: process.memoryUsage().rss,
      startedAt: this.startedAt,
      startedMonotonicAt: this.startedMonotonicAt,
      ...(this.lastNavigationAt === undefined ? {} : { lastNavigationAt: this.lastNavigationAt }),
      ...(this.lastCompletedMonotonicAt === undefined
        ? {}
        : { lastCompletedMonotonicAt: this.lastCompletedMonotonicAt }),
      productVersion: this.options.symnavVersion,
      instanceId: this.options.instanceId,
      hardProcessRssBytes: this.resourcePolicy.hardProcessRssBytes,
      queue,
      resources,
      worker: {
        generation: worker.generation,
        ready: worker.ready,
        ...(worker.fileCount === undefined ? {} : { fileCount: worker.fileCount }),
      },
    }).pong;
  }

  private async acceptExecution(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    send: DaemonServerSend,
  ): Promise<DaemonResponse | void> {
    const decision = this.decideAdmission(request);
    if (decision.kind === "disconnect") {
      throw new Error("Daemon execution request does not match process instance");
    }
    if (decision.kind === "reject") return this.rejection(request, decision.code);
    const existing = this.acceptedRequests.entryFor(request.requestId);
    const entry = this.acceptedRequests.accept(
      request.requestId,
      request.commandName,
      request.request,
    );
    if (entry.state.state === "queued") {
      this.acceptances.set(request.requestId, {
        acceptedAt: entry.state.acceptedAt,
        queuePosition: entry.state.queuePosition,
      });
      if (existing === undefined) {
        const trace = this.operationObserver.start(request.requestId, request.commandName);
        this.operationTraces.set(request.requestId, trace);
        trace.accepted(entry.state.queuePosition, this.resourceSupervisor.snapshot.generation);
      }
    }
    const acceptance = this.acceptances.get(request.requestId);
    if (acceptance === undefined) throw new Error("Accepted request is missing admission metadata");
    const traceWasDisconnected = !this.operationTraceConnections.has(request.requestId);
    const disconnectTraceConnection = this.attachOperationTraceConnection(request.requestId, send);
    if (existing === undefined) {
      this.lastNavigationAt = this.now();
      this.lifetime.navigationAccepted();
      void this.executeAccepted(request);
    } else if (traceWasDisconnected) {
      this.reattachOperationTrace(request.requestId);
    }
    try {
      await this.deliver(send, {
        kind: "accepted",
        instanceId: this.options.instanceId,
        processToken: this.options.processToken,
        requestId: request.requestId,
        ...acceptance,
      });
    } catch (error) {
      disconnectTraceConnection();
      throw error;
    }
    if (entry.state.state === "completed") {
      try {
        await this.deliverStoredCompletion(request.requestId, send);
      } catch (error) {
        disconnectTraceConnection();
        throw error;
      }
      return;
    }
    if (entry.state.state === "failed") {
      try {
        await this.deliver(send, this.failedFrame(request.requestId, entry.state.code));
      } catch (error) {
        disconnectTraceConnection();
        throw error;
      }
      this.completeOperationTrace(request.requestId, "delivered");
      return;
    }
    let unsubscribe: (() => void) | undefined;
    unsubscribe = this.acceptedRequests.subscribe(request.requestId, (updated) => {
      if (updated.state.state === "completed") {
        this.trackCompletionDelivery(request.requestId, send, disconnectTraceConnection);
        unsubscribe?.();
      } else if (updated.state.state === "failed") {
        void this.deliver(send, this.failedFrame(request.requestId, updated.state.code))
          .then(() => this.completeOperationTrace(request.requestId, "delivered"))
          .catch((error) =>
            this.recordDeliveryFailure(request.requestId, error, disconnectTraceConnection),
          );
        unsubscribe?.();
      }
    });
  }

  private decideAdmission(
    request: Extract<DaemonRequest, { kind: "execute" }>,
  ): DaemonAdmissionDecision {
    const authenticated = request.processToken === this.options.processToken;
    if (!authenticated) {
      return this.admissionPolicy.decide({
        request,
        authenticated,
        workerReady: true,
        resourceAdmissionPaused: false,
        queueState: "accepting",
        compatibility: "unseen",
      });
    }
    void this.resourceSupervisor.sample("admission").catch((error) => {
      this.logger.record({
        kind: "failure",
        operation: "resource-sample",
        failureCode: "operation-failed",
        errorName: DaemonLogger.errorName(error),
      });
    });
    return this.admissionPolicy.decide({
      request,
      authenticated,
      workerReady: this.workerManager.snapshot.ready,
      resourceAdmissionPaused: this.resourceSupervisor.snapshot.admissionPaused,
      queueState: this.requestQueue.state,
      compatibility: this.acceptedRequests.compatibilityFor(
        request.requestId,
        request.commandName,
        request.request,
      ),
    });
  }

  private async executeAccepted(
    request: Extract<DaemonRequest, { kind: "execute" }>,
  ): Promise<void> {
    let spool: CompletionSpool | undefined;
    try {
      await this.requestQueue.enqueue(
        {
          requestId: request.requestId,
          command: request.commandName,
          acceptedAt: this.clock.monotonicNowMs(),
        },
        async () => {
          this.operationTraces
            .get(request.requestId)
            ?.turnStarted(this.resourceSupervisor.snapshot.generation);
          try {
            spool = await this.completionSpools.create(request.requestId);
            this.acceptedRequests.markRunning(request.requestId, this.now());
            const response = await this.workerManager.execute(
              request.requestId,
              { commandName: request.commandName, request: request.request },
              spool,
            );
            this.resourceSupervisor.workerHeapReported(
              response.generation,
              response.resources.workerHeapUsedBytes,
              response.resources.workerHeapLimitBytes,
              response.resources.peakWorkerHeapUsedBytes,
            );
            this.operationTraces.get(request.requestId)?.workerCompleted(
              {
                freshnessMs: response.durations.freshnessMs,
                navigationMs: response.durations.navigationMs,
                renderMs: response.durations.renderMs,
                workerOutputMs: response.durations.outputMs,
              },
              response.refresh,
            );
            const spoolStartedAt = this.clock.monotonicNowMs();
            const manifest = await spool.finish(response.result.exitCode);
            this.operationTraces
              .get(request.requestId)
              ?.spooled(manifest, Math.max(0, this.clock.monotonicNowMs() - spoolStartedAt));
            const workspaceDeleted = await this.recordCompletion();
            this.operationTraces.get(request.requestId)?.executionTerminated("completed");
            this.acceptedRequests.complete(request.requestId, request.requestId, this.now());
            await this.completionDeliveries.get(request.requestId);
            if (workspaceDeleted) {
              await this.waitForCompletionAcknowledgements();
              setTimeout(() => void this.shutdown("workspace-deleted", true), 0);
            }
          } finally {
            this.scheduleTurnCompleteResourceSample();
          }
        },
      );
    } catch (error) {
      this.operationTraces.get(request.requestId)?.executionTerminated("failed");
      this.logger.record({
        kind: "failure",
        operation: "request",
        failureCode: "internal",
        errorName: DaemonLogger.errorName(error),
      });
      const code = DaemonExecutionFailures.classify({
        resourceInterrupted: this.resourceInterruptedRequests.delete(request.requestId),
        responseCapacityExceeded: error instanceof CompletionSpoolCapacityError,
        workerExited: error instanceof DaemonNavigationWorkerExitedError,
        ...(this.shutdownFailureCode === undefined
          ? {}
          : { shutdownFailureCode: this.shutdownFailureCode }),
        shutdownStarted: this.shutdownStarted,
      });
      await spool?.dispose().catch((cleanupError) => {
        this.logger.record({
          kind: "failure",
          operation: "completion-cleanup",
          failureCode: "internal",
          errorName: DaemonLogger.errorName(cleanupError),
        });
      });
      this.acceptedRequests.fail(request.requestId, code, this.now());
    } finally {
      if (this.requestQueue.isIdle) this.lifetime.queueBecameIdle();
    }
  }

  private scheduleTurnCompleteResourceSample(): void {
    void this.requestQueue
      .scheduleAtTurnBoundary(() => this.resourceSupervisor.sampleAtTurnBoundary())
      .catch((error) => {
        this.logger.record({
          kind: "failure",
          operation: "resource-sample",
          failureCode: "operation-failed",
          errorName: DaemonLogger.errorName(error),
        });
      })
      .finally(() => {
        if (this.requestQueue.isIdle) this.lifetime.queueBecameIdle();
      });
  }

  private async recordCompletion(): Promise<boolean> {
    this.lastCompletedMonotonicAt = this.clock.monotonicNowMs();
    const exists = this.options.dependencies
      ? await this.options.dependencies.fs.exists(this.options.identity.workspaceRoot)
      : await WorkspaceDaemon.pathExists(this.options.identity.workspaceRoot);
    return !exists;
  }

  private static async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private rejection(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    code: DaemonExecuteRejectionCode,
  ): DaemonExecutionServerFrame {
    return DaemonAdmissionRejections.frame(code, {
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId: request.requestId,
    });
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
        failureCode: "internal",
        errorName: DaemonLogger.errorName(error),
      });
      await spool.dispose().catch((cleanupError) => {
        this.logger.record({
          kind: "failure",
          operation: "completion-cleanup",
          failureCode: "internal",
          errorName: DaemonLogger.errorName(cleanupError),
        });
      });
      this.acceptedRequests.invalidateCompletion(requestId, "internal", this.now());
      await this.deliver(send, this.failedFrame(requestId, "internal"));
      this.completeOperationTrace(requestId, "failed");
    }
  }

  private trackCompletionDelivery(
    requestId: string,
    send: DaemonServerSend,
    disconnectTraceConnection: () => void,
  ): void {
    const delivery = this.deliverStoredCompletion(requestId, send).catch((error) =>
      this.recordDeliveryFailure(requestId, error, disconnectTraceConnection),
    );
    this.completionDeliveries.set(requestId, delivery);
    void delivery.finally(() => {
      if (this.completionDeliveries.get(requestId) === delivery) {
        this.completionDeliveries.delete(requestId);
      }
    });
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
    this.terminateOperationDelivery(requestId, "delivered");
  }

  private recordDeliveryFailure(
    requestId: string,
    error: unknown,
    disconnectTraceConnection: () => void,
  ): void {
    disconnectTraceConnection();
    this.logger.record({
      kind: "failure",
      operation: "completion-delivery",
      failureCode: "internal",
      errorName: DaemonLogger.errorName(error),
    });
  }

  private completeOperationTrace(requestId: string, outcome: DaemonDeliveryOutcome): void {
    const expiration = this.operationTraceExpirations.get(requestId);
    if (expiration !== undefined) clearTimeout(expiration);
    this.operationTraceExpirations.delete(requestId);
    this.operationTraceConnections.delete(requestId);
    this.terminateOperationDelivery(requestId, outcome);
    this.operationTraces.delete(requestId);
  }

  private terminateOperationDelivery(requestId: string, outcome: DaemonDeliveryOutcome): void {
    if (!this.acceptedRequests.terminateDelivery(requestId)) return;
    const trace = this.operationTraces.get(requestId);
    if (trace === undefined) this.operationObserver.deliveryTerminated(requestId, outcome, 0);
    else trace.deliveryTerminated(outcome);
  }

  private completeRetainedOperationTraces(): void {
    for (const requestId of this.operationTraces.keys()) {
      this.completeOperationTrace(requestId, "disconnected");
    }
  }

  private disconnectOperationTrace(requestId: string): void {
    if (this.operationTraceExpirations.has(requestId)) return;
    const trace = this.operationTraces.get(requestId);
    if (trace === undefined) return;
    trace.clientDisconnected();
    const expiration = setTimeout(
      () => this.expireOperationTrace(requestId),
      this.policy.values.diagnostics.disconnectedTraceRetentionMs,
    );
    expiration.unref();
    this.operationTraceExpirations.set(requestId, expiration);
    this.enforceOperationTraceCapacity();
  }

  private attachOperationTraceConnection(requestId: string, send: DaemonServerSend): () => void {
    const connectionCount = this.operationTraceConnections.get(requestId) ?? 0;
    if (connectionCount === 0) {
      const expiration = this.operationTraceExpirations.get(requestId);
      if (expiration !== undefined) clearTimeout(expiration);
      this.operationTraceExpirations.delete(requestId);
    }
    this.operationTraceConnections.set(requestId, connectionCount + 1);
    let connectionClosed = false;
    const disconnect = (): void => {
      if (connectionClosed) return;
      connectionClosed = true;
      const remainingConnections = (this.operationTraceConnections.get(requestId) ?? 1) - 1;
      if (remainingConnections > 0) {
        this.operationTraceConnections.set(requestId, remainingConnections);
        return;
      }
      this.operationTraceConnections.delete(requestId);
      this.disconnectOperationTrace(requestId);
    };
    send.onClose(disconnect);
    return disconnect;
  }

  private reattachOperationTrace(requestId: string): void {
    if (this.acceptedRequests.isDeliveryTerminated(requestId)) return;
    const trace = this.operationTraces.get(requestId);
    if (trace === undefined) this.operationObserver.reattached(requestId);
    else trace.reattached();
  }

  private expireOperationTrace(requestId: string): void {
    this.operationTraceExpirations.delete(requestId);
    this.operationTraceConnections.delete(requestId);
    if (!this.operationTraces.delete(requestId)) return;
    this.operationObserver.traceExpired(requestId);
  }

  private enforceOperationTraceCapacity(): void {
    const capacity = Math.max(1, this.policy.values.diagnostics.maximumDisconnectedTraces);
    while (this.operationTraceExpirations.size > capacity) {
      const oldestRequestId = this.operationTraceExpirations.keys().next().value as
        | string
        | undefined;
      if (oldestRequestId === undefined) return;
      const expiration = this.operationTraceExpirations.get(oldestRequestId);
      if (expiration !== undefined) clearTimeout(expiration);
      this.expireOperationTrace(oldestRequestId);
    }
  }

  private async drainAndShutdown(reason: "idle"): Promise<void> {
    await this.requestQueue.drain();
    await this.shutdown(reason);
  }

  private beginGracefulShutdown(): void {
    this.shutdownFailureCode ??= "stopping";
    this.resourceSupervisor.stop();
  }

  private async initiateResourceDrain(): Promise<void> {
    await this.waitForCompletionAcknowledgements();
    void this.shutdown("resource", true).catch((error) => {
      this.logger.record({
        kind: "failure",
        operation: "resource-drain",
        failureCode: "controlled-resource",
        errorName: DaemonLogger.errorName(error),
      });
    });
  }

  private async waitForCompletionAcknowledgements(): Promise<void> {
    const acknowledgementDeadline =
      Date.now() + this.policy.values.shutdown.resourceDrainAcknowledgementGraceMs;
    while (
      this.acceptedRequests.hasUnacknowledgedCompletions &&
      Date.now() < acknowledgementDeadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.policy.values.shutdown.resourceDrainAcknowledgementPollIntervalMs),
      );
    }
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
    this.operationObserver.shutdown({ kind: "shutdown", reason, force });
    this.logger.record({ kind: "stop", reason });
    try {
      await this.server?.close();
    } catch (error) {
      this.logger.record({
        kind: "failure",
        operation: "transport-close",
        failureCode: "operation-failed",
        errorName: DaemonLogger.errorName(error),
      });
    }
    await this.completionSpools.cleanupInstance(this.options.instanceId).catch((error) => {
      this.logger.record({
        kind: "failure",
        operation: "completion-cleanup",
        failureCode: "internal",
        errorName: DaemonLogger.errorName(error),
      });
    });
    this.completeRetainedOperationTraces();
    await this.logger.close();
    this.exit(0);
  }

  private async gracefullyShutdownWorker(): Promise<void> {
    await this.requestQueue.drain();
    const gracefulClose = this.workerManager.close();
    await Promise.race([gracefulClose, this.forceEscalated.then(() => this.forceWorkerShutdown())]);
  }

  private forceWorkerShutdown(): Promise<void> {
    if (this.forcedWorkerShutdown !== undefined) return this.forcedWorkerShutdown;
    this.requestQueue.close();
    this.forcedWorkerShutdown = this.workerManager
      .terminate()
      .then(() => this.requestQueue.drain());
    this.resolveForceEscalated();
    return this.forcedWorkerShutdown;
  }

  private pause(): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, this.policy.values.startup.authorizationPollIntervalMs),
    );
  }

  private markActiveResourceInterruption(cause: DaemonWorkerReplacementCause): void {
    if (cause === "worker-exit") return;
    const activeRequest = this.requestQueue.snapshot.active;
    if (activeRequest !== undefined) this.resourceInterruptedRequests.add(activeRequest.requestId);
  }

  private async recoverWorkerExit(
    workerExit: import("./daemon-navigation-worker.js").DaemonNavigationWorkerExit,
  ): Promise<void> {
    if (this.shutdownStarted) return;
    this.logger.record({
      kind: "failure",
      operation: "worker-exit",
      failureCode: "worker-exit",
      errorName: DaemonLogger.errorName(
        workerExit.errorName === undefined ? undefined : { name: workerExit.errorName },
      ),
    });
    try {
      await this.resourceSupervisor.recover(workerExit);
    } catch (error) {
      this.logger.record({
        kind: "failure",
        operation: "worker-replacement",
        failureCode: "controlled-resource",
        errorName: DaemonLogger.errorName(error),
      });
      throw error;
    }
  }
}
