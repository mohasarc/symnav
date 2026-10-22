import { access } from "node:fs/promises";
import {
  DaemonAdmissionPolicy,
  DaemonAdmissionRejections,
  type DaemonAdmissionDecision,
  type DaemonExecuteRejectionCode,
  type DaemonExecutorModuleUrl,
  type DaemonPolicy,
  type DaemonPolicyValues,
} from "@symnav/daemon";
import { AcceptedRequestLedger } from "./accepted-request-ledger.js";
import { AcceptedExecutionSession } from "./accepted-execution-session.js";
import { DaemonActivityProjector } from "./daemon-activity-projector.js";
import type {
  DaemonExecutionServerFrame,
  DaemonIdentityCoordinates,
  DaemonRecord,
  DaemonRequest,
  DaemonResponse,
  DaemonServer,
} from "./daemon-protocol.js";
import { DaemonCompletionSpoolStore, type CompletionSpoolStorage } from "./completion-spool.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import { DaemonLifetime } from "./daemon-lifetime.js";
import { DaemonLogger } from "./daemon-logger.js";
import type { DaemonClock } from "./daemon-clock.js";
import { DaemonOperationObserver } from "./daemon-operation-observer.js";
import { DaemonDeliverySession } from "./daemon-delivery-session.js";
import {
  type DaemonNavigationWorker,
  NodeDaemonNavigationWorker,
} from "./daemon-navigation-worker.js";
import { DaemonWorkerGenerationManager } from "./daemon-worker-generation-manager.js";
import { DaemonResourceSupervisor } from "./daemon-resource-monitor.js";
import type { DaemonRegistry, DaemonStartupLease } from "./daemon-registry.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { DaemonRequestServer, DaemonServerSend } from "./daemon-transport.js";
import { WorkspaceRequestQueue } from "./workspace-request-queue.js";

export interface DaemonProcessCoordinatorOptions {
  readonly identity: DaemonWorkspaceIdentity;
  readonly coordinates: DaemonIdentityCoordinates;
  readonly productVersion: string;
  readonly executorModuleUrl?: DaemonExecutorModuleUrl;
  readonly policy: DaemonPolicy;
  readonly workspaceExists?: (workspaceRoot: string) => Promise<boolean>;
  readonly registry: DaemonRegistry;
  readonly server: DaemonRequestServer;
  readonly navigationWorker?: DaemonNavigationWorker;
  readonly navigationWorkerFactory?: (generation: number) => DaemonNavigationWorker;
  readonly clock: DaemonClock;
  readonly exit?: (code: number) => void;
  readonly residentMemoryBytes?: () => number;
  readonly completionSpoolStorage?: CompletionSpoolStorage;
  readonly logger?: DaemonLogger;
}

export class DaemonProcessCoordinator {
  private readonly clock: DaemonClock;
  private readonly exit: (code: number) => void;
  private readonly workerManager: DaemonWorkerGenerationManager;
  private readonly acceptedExecutionSession: AcceptedExecutionSession;
  private readonly logger: DaemonLogger;
  private readonly lifetime: DaemonLifetime;
  private readonly resourceSupervisor: DaemonResourceSupervisor;
  private readonly resourcePolicy: DaemonPolicyValues["resources"];
  private readonly policy: DaemonPolicy;
  private readonly operationObserver: DaemonOperationObserver;
  private readonly deliverySession: DaemonDeliverySession;
  private readonly admissionPolicy = new DaemonAdmissionPolicy();
  private server: DaemonServer | undefined;
  private startedAt = 0;
  private readonly startedMonotonicAt: number;
  private shutdownStarted = false;
  private shutdownFailureCode: "stopping" | "controlled-resource" | undefined;
  private shutdownOperation: Promise<void> | undefined;
  private forcedWorkerShutdown: Promise<void> | undefined;
  private readonly forceEscalated: Promise<void>;
  private resolveForceEscalated!: () => void;

  constructor(private readonly options: DaemonProcessCoordinatorOptions) {
    DaemonProcessCoordinator.validateCoordinates(options.identity, options.coordinates);
    const policy = options.policy;
    this.policy = policy;
    this.forceEscalated = new Promise((resolve) => {
      this.resolveForceEscalated = resolve;
    });
    this.clock = options.clock;
    this.startedMonotonicAt = this.clock.monotonicNowMs();
    const requestQueue = new WorkspaceRequestQueue(this.clock);
    const acceptedRequests = new AcceptedRequestLedger(this.clock);
    const completionSpools = new DaemonCompletionSpoolStore({
      directory: options.identity.spoolDirectory,
      workspaceKey: options.identity.workspaceKey,
      instanceId: options.coordinates.instanceId,
      policy: policy.values.output,
      ...(options.completionSpoolStorage === undefined
        ? {}
        : { storage: options.completionSpoolStorage }),
    });
    this.logger =
      options.logger ??
      new DaemonLogger(options.identity, options.coordinates.instanceId, this.clock, {
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
                productVersion: options.productVersion,
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
    this.lifetime = new DaemonLifetime(this.clock, policy.values.shutdown, () =>
      this.drainAndShutdown("idle"),
    );
    this.workerManager = new DaemonWorkerGenerationManager({
      workspaceRoot: options.identity.workspaceRoot,
      initialWorker: initialNavigationWorker,
      createWorker: createNavigationWorker,
      exitRecovery: { recover: (workerExit) => this.recoverWorkerExit(workerExit) },
      onActiveResourceInterruption: (cause) =>
        this.acceptedExecutionSession.markActiveResourceInterrupted(cause),
      onDiagnostic: (diagnostic) => this.operationObserver.worker(diagnostic),
    });
    this.resourceSupervisor = new DaemonResourceSupervisor({
      policy: resourcePolicy,
      generation: this.workerManager.snapshot.generation,
      clock: this.clock,
      ...(options.residentMemoryBytes === undefined
        ? {}
        : { residentMemoryBytes: options.residentMemoryBytes }),
      spoolBytes: () => this.deliverySession.snapshot.spoolBytes,
      scheduleAtTurnBoundary: (operation) =>
        this.acceptedExecutionSession.scheduleAtTurnBoundary(operation),
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
    this.deliverySession = new DaemonDeliverySession({
      coordinates: {
        instanceId: options.coordinates.instanceId,
        processToken: options.coordinates.processToken,
      },
      journal: acceptedRequests,
      spoolStore: completionSpools,
      observer: this.operationObserver,
      diagnostics: this.logger,
      clock: this.clock,
      policy: policy.values,
    });
    this.acceptedExecutionSession = new AcceptedExecutionSession({
      ledger: acceptedRequests,
      queue: requestQueue,
      worker: this.workerManager,
      delivery: this.deliverySession,
      resourceSupervisor: this.resourceSupervisor,
      processLifecycle: {
        shutdownSnapshot: () => ({
          started: this.shutdownStarted,
          ...(this.shutdownFailureCode === undefined
            ? {}
            : { failureCode: this.shutdownFailureCode }),
        }),
        workspaceExists: () => this.workspaceExists(),
        workspaceDeletedAfterDelivery: () => this.workspaceDeletedAfterDelivery(),
      },
      lifetime: this.lifetime,
      diagnostics: this.logger,
      clock: {
        wallNowMs: () => this.clock.wallNowMs(),
        monotonicNowMs: () => this.clock.monotonicNowMs(),
      },
    });
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
      this.server = await this.options.server.listen(
        this.options.coordinates.endpoint,
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
      this.workerManager.activateReadiness();
      const readyRecord: DaemonRecord = {
        schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        symnavVersion: this.options.productVersion,
        workspaceRoot: this.options.identity.workspaceRoot,
        workspaceKey: this.options.identity.workspaceKey,
        stateKey: this.options.identity.stateKey,
        identityKey: this.options.identity.identityKey,
        instanceId: this.options.coordinates.instanceId,
        processToken: this.options.coordinates.processToken,
        endpoint: this.options.coordinates.endpoint,
        pid: process.pid,
        state: "ready",
        startedAt: startingRecord.startedAt,
        readyAt: this.clock.wallNowMs(),
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
    const deadline = this.clock.wallNowMs() + this.policy.values.startup.coordinationGraceMs;
    while (this.clock.wallNowMs() <= deadline) {
      const record = this.options.registry.readInstance(
        this.options.identity,
        this.options.coordinates.instanceId,
      );
      if (
        record?.state === "starting" &&
        (record.pid === 0 || record.pid === process.pid) &&
        record.processToken === this.options.coordinates.processToken
      ) {
        const lease = this.options.registry.claimStartupForDaemon(
          this.options.identity,
          this.options.coordinates.instanceId,
          this.options.coordinates.processToken,
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
          this.options.coordinates.instanceId,
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
      this.options.coordinates.instanceId,
      this.options.coordinates.processToken,
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
      request.instanceId !== this.options.coordinates.instanceId
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
      if (request.processToken !== this.options.coordinates.processToken) {
        throw new Error("Daemon execution request does not match process instance");
      }
    }
    if (request.kind === "result-fetch") {
      await this.deliverySession.fetch(request, send);
      return;
    }
    if (request.kind === "result-ack") {
      return this.deliverySession.acknowledge(request);
    }
    if (request.kind === "execution-status") {
      return {
        kind: "execution-status",
        instanceId: this.options.coordinates.instanceId,
        processToken: this.options.coordinates.processToken,
        requestId: request.requestId,
        status: this.acceptedExecutionSession.status(request.requestId),
      };
    }
    this.beginGracefulShutdown();
    await this.acceptedExecutionSession.drain();
    await this.deliverySession.waitForCompletionAcknowledgements();
    setTimeout(() => void this.shutdown("graceful"), 0);
    return { kind: "stopped", instanceId: this.options.coordinates.instanceId };
  }

  private identify(request: Extract<DaemonRequest, { kind: "identify" }>): DaemonResponse {
    if (
      request.instanceId !== this.options.coordinates.instanceId ||
      request.processToken !== this.options.coordinates.processToken
    ) {
      throw new Error("Daemon identity request does not match process instance");
    }
    return {
      kind: "identity",
      instanceId: this.options.coordinates.instanceId,
      processToken: this.options.coordinates.processToken,
      pid: process.pid,
      startedAt: this.startedAt,
    };
  }

  private async terminate(
    request: Extract<DaemonRequest, { kind: "terminate" | "kill" }>,
  ): Promise<DaemonResponse> {
    if (
      request.instanceId !== this.options.coordinates.instanceId ||
      request.processToken !== this.options.coordinates.processToken
    ) {
      throw new Error("Daemon termination does not match process instance");
    }
    this.beginGracefulShutdown();
    if (request.kind === "terminate") {
      await this.acceptedExecutionSession.drain();
      await this.deliverySession.waitForCompletionAcknowledgements();
      setTimeout(() => void this.shutdown("graceful"), 0);
    } else {
      setTimeout(() => void this.shutdown("graceful", true), 0);
    }
    return {
      kind: request.kind === "terminate" ? "terminating" : "killing",
      instanceId: this.options.coordinates.instanceId,
      processToken: this.options.coordinates.processToken,
    };
  }

  private pong(): DaemonResponse {
    const execution = this.acceptedExecutionSession.snapshot;
    const resources = this.resourceSupervisor.snapshot;
    const worker = this.workerManager.snapshot;
    return DaemonActivityProjector.project({
      nowMonotonicMs: this.clock.monotonicNowMs(),
      pid: process.pid,
      processRssBytes: process.memoryUsage().rss,
      startedAt: this.startedAt,
      startedMonotonicAt: this.startedMonotonicAt,
      ...(execution.lastNavigationAt === undefined
        ? {}
        : { lastNavigationAt: execution.lastNavigationAt }),
      ...(execution.lastCompletedMonotonicAt === undefined
        ? {}
        : { lastCompletedMonotonicAt: execution.lastCompletedMonotonicAt }),
      productVersion: this.options.productVersion,
      instanceId: this.options.coordinates.instanceId,
      hardProcessRssBytes: this.resourcePolicy.hardProcessRssBytes,
      queue: execution.queue,
      resources,
      worker: {
        generation: worker.generation,
        ready: worker.ready,
        fileCount: worker.fileCount ?? 0,
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
    const admission = this.acceptedExecutionSession.accept(request);
    await this.deliverySession.attach(
      {
        ...admission.acceptance,
      },
      send,
    );
  }

  private decideAdmission(
    request: Extract<DaemonRequest, { kind: "execute" }>,
  ): DaemonAdmissionDecision {
    const authenticated = request.processToken === this.options.coordinates.processToken;
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
      queueState: this.acceptedExecutionSession.snapshot.queue.state,
      compatibility: this.acceptedExecutionSession.compatibilityFor(request),
    });
  }

  private workspaceExists(): Promise<boolean> {
    return (
      this.options.workspaceExists?.(this.options.identity.workspaceRoot) ??
      DaemonProcessCoordinator.pathExists(this.options.identity.workspaceRoot)
    );
  }

  private async workspaceDeletedAfterDelivery(): Promise<void> {
    await this.deliverySession.waitForCompletionAcknowledgements();
    setTimeout(() => void this.shutdown("workspace-deleted", true), 0);
  }

  private static async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private static validateCoordinates(
    identity: DaemonWorkspaceIdentity,
    coordinates: DaemonIdentityCoordinates,
  ): void {
    if (
      coordinates.workspaceRoot !== identity.workspaceRoot ||
      coordinates.workspaceKey !== identity.workspaceKey ||
      coordinates.stateKey !== identity.stateKey ||
      coordinates.identityKey !== identity.identityKey ||
      coordinates.endpoint !== identity.endpoint(coordinates.instanceId)
    ) {
      throw new Error("Daemon process identity does not match configuration");
    }
  }

  private rejection(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    code: DaemonExecuteRejectionCode,
  ): DaemonExecutionServerFrame {
    return DaemonAdmissionRejections.frame(code, {
      instanceId: this.options.coordinates.instanceId,
      processToken: this.options.coordinates.processToken,
      requestId: request.requestId,
    });
  }

  private async drainAndShutdown(reason: "idle"): Promise<void> {
    await this.acceptedExecutionSession.drain();
    await this.shutdown(reason);
  }

  private beginGracefulShutdown(): void {
    this.shutdownFailureCode ??= "stopping";
    this.resourceSupervisor.stop();
  }

  private async initiateResourceDrain(): Promise<void> {
    await this.deliverySession.waitForCompletionAcknowledgements();
    void this.shutdown("resource", true).catch((error) => {
      this.logger.record({
        kind: "failure",
        operation: "resource-drain",
        failureCode: "controlled-resource",
        errorName: DaemonLogger.errorName(error),
      });
    });
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
    await this.deliverySession.cleanupInstance();
    this.deliverySession.completeRetainedTraces();
    await this.logger.close();
    this.exit(0);
  }

  private async gracefullyShutdownWorker(): Promise<void> {
    await this.acceptedExecutionSession.drain();
    const gracefulClose = this.workerManager.close();
    await Promise.race([gracefulClose, this.forceEscalated.then(() => this.forceWorkerShutdown())]);
  }

  private forceWorkerShutdown(): Promise<void> {
    if (this.forcedWorkerShutdown !== undefined) return this.forcedWorkerShutdown;
    this.acceptedExecutionSession.close();
    this.forcedWorkerShutdown = this.workerManager
      .terminate()
      .then(() => this.acceptedExecutionSession.drain());
    this.resolveForceEscalated();
    return this.forcedWorkerShutdown;
  }

  private pause(): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, this.policy.values.startup.authorizationPollIntervalMs),
    );
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
