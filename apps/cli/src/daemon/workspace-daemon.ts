import type { ProgramDependencies } from "../program-dependencies.js";
import type { CommandExecutionResult } from "../command-execution-result.js";
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
  DaemonServer,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import { DAEMON_IDLE_TIMEOUT_MS, DaemonLifetime } from "./daemon-lifetime.js";
import { DaemonLogger } from "./daemon-logger.js";
import {
  type DaemonNavigationWorker,
  NodeDaemonNavigationWorker,
} from "./daemon-navigation-worker.js";
import { DaemonResourceMonitor } from "./daemon-resource-monitor.js";
import {
  DAEMON_STARTUP_TIMEOUT_MS,
  type DaemonRegistry,
  type DaemonStartupLease,
} from "./daemon-registry.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";
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
  readonly now?: () => number;
  readonly exit?: (code: number) => void;
  readonly idleTimeoutMs?: number;
  readonly resourceCheckIntervalMs?: number;
  readonly residentMemoryBytes?: () => number;
  readonly startupHeartbeatIntervalMs?: number;
}

export class WorkspaceDaemon {
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private readonly navigationWorker: DaemonNavigationWorker;
  private readonly requestQueue: WorkspaceRequestQueue;
  private readonly logger: DaemonLogger;
  private readonly lifetime: DaemonLifetime;
  private readonly resourceMonitor: DaemonResourceMonitor;
  private readonly acceptedRequests: AcceptedRequestLedger;
  private readonly acceptedResults = new Map<string, CommandExecutionResult>();
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

  constructor(private readonly options: WorkspaceDaemonOptions) {
    this.forceEscalated = new Promise((resolve) => {
      this.resolveForceEscalated = resolve;
    });
    this.now = options.now ?? Date.now;
    this.requestQueue = new WorkspaceRequestQueue(this.now);
    this.acceptedRequests = new AcceptedRequestLedger(this.now);
    this.logger = new DaemonLogger(options.identity.logPath, { now: this.now });
    this.navigationWorker =
      options.navigationWorker ??
      new NodeDaemonNavigationWorker({
        generation: 1,
        stateDirectory: options.identity.stateDirectory,
      });
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.lifetime = new DaemonLifetime(
      { now: this.now },
      options.idleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS,
      () => this.drainAndShutdown("idle"),
    );
    this.resourceMonitor = new DaemonResourceMonitor({
      memoryCapBytes: options.memoryCapBytes,
      ...(options.resourceCheckIntervalMs === undefined
        ? {}
        : { intervalMs: options.resourceCheckIntervalMs }),
      ...(options.residentMemoryBytes === undefined
        ? {}
        : { residentMemoryBytes: options.residentMemoryBytes }),
      onExceeded: () => this.shutdown("resource", true),
    });
    void this.navigationWorker.exited.then((exit) => {
      if (this.shutdownStarted) return;
      this.shutdownFailureCode = "worker-exit";
      this.logger.record({
        kind: "failure",
        operation: "worker-exit",
        message: `${exit.cause}${exit.errorName === undefined ? "" : ` (${exit.errorName})`}`,
      });
      void this.shutdown("resource", true);
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
      const response = await this.navigationWorker.start(this.options.identity.workspaceRoot);
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
      this.resourceMonitor.start();
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
      await this.navigationWorker.terminate();
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
    send: (response: DaemonResponse) => void,
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
    if (request.kind === "execute" || request.kind === "execution-status") {
      if (request.processToken !== this.options.processToken) {
        throw new Error("Daemon execution request does not match process instance");
      }
    }
    if (request.kind === "execute") return this.acceptExecution(request, send);
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

  private acceptExecution(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    send: (response: DaemonResponse) => void,
  ): DaemonResponse | void {
    if (!this.workerReady) return this.rejection(request, "not-ready", true);
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
    this.deliver(send, {
      kind: "accepted",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId: request.requestId,
      ...acceptance,
    });
    if (entry.state.state === "completed") {
      const result = this.acceptedResults.get(entry.state.resultId);
      if (result === undefined) throw new Error("Accepted request result is missing");
      this.deliver(send, this.completedFrame(request.requestId, result));
      return;
    }
    if (entry.state.state === "failed") {
      this.deliver(send, this.failedFrame(request.requestId, entry.state.code));
      return;
    }
    let unsubscribe: (() => void) | undefined;
    unsubscribe = this.acceptedRequests.subscribe(request.requestId, (updated) => {
      if (updated.state.state === "completed") {
        const result = this.acceptedResults.get(updated.state.resultId);
        if (result !== undefined)
          this.deliver(send, this.completedFrame(request.requestId, result));
        unsubscribe?.();
      } else if (updated.state.state === "failed") {
        this.deliver(send, this.failedFrame(request.requestId, updated.state.code));
        unsubscribe?.();
      }
    });
    if (existing !== undefined) return;
    this.lastNavigationAt = this.now();
    this.lifetime.navigationAccepted();
    void this.executeAccepted(request);
  }

  private async executeAccepted(
    request: Extract<DaemonRequest, { kind: "execute" }>,
  ): Promise<void> {
    const requestStartedAt = this.now();
    try {
      const result = await this.requestQueue.enqueue(
        {
          requestId: request.requestId,
          command: WorkspaceDaemon.commandName(request.request.argv),
          acceptedAt: this.now(),
        },
        async () => {
          this.acceptedRequests.markRunning(request.requestId, this.now());
          const response = await this.navigationWorker.execute(request.requestId, request.request);
          if (response.kind !== "result" || response.requestId !== request.requestId) {
            throw new Error("Navigation worker returned an uncorrelated result");
          }
          this.logger.record({ kind: "freshness", ...response.refresh });
          return response.result;
        },
      );
      const completedFrame = this.completedFrame(request.requestId, result);
      const capacityTransport = this.options.transport as LocalDaemonTransport & {
        canFrame?: (value: unknown) => boolean;
      };
      if (capacityTransport.canFrame?.(completedFrame) === false) {
        this.acceptedRequests.fail(request.requestId, "response-capacity", this.now());
        return;
      }
      this.acceptedResults.set(request.requestId, result);
      this.acceptedRequests.complete(request.requestId, request.requestId, this.now());
      await this.recordCompletion(request, requestStartedAt, result);
    } catch (error) {
      this.logger.record({
        kind: "failure",
        operation: "request",
        message: WorkspaceDaemon.errorMessage(error),
      });
      const code = this.shutdownFailureCode ?? (this.shutdownStarted ? "stopping" : "internal");
      this.acceptedRequests.fail(request.requestId, code, this.now());
    } finally {
      if (this.requestQueue.isIdle) this.lifetime.queueBecameIdle();
    }
  }

  private async recordCompletion(
    request: Extract<DaemonRequest, { kind: "execute" }>,
    requestStartedAt: number,
    result: CommandExecutionResult,
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
    code: "not-ready" | "draining" | "incompatible",
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

  private completedFrame(
    requestId: string,
    result: CommandExecutionResult,
  ): DaemonExecutionServerFrame {
    return {
      kind: "completed",
      instanceId: this.options.instanceId,
      processToken: this.options.processToken,
      requestId,
      result,
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

  private deliver(send: (response: DaemonResponse) => void, frame: DaemonResponse): void {
    try {
      send(frame);
    } catch {}
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
    this.resourceMonitor.stop();
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
    this.exit(0);
  }

  private async gracefullyShutdownWorker(): Promise<void> {
    await this.requestQueue.drain();
    const gracefulClose = this.navigationWorker.drainAndClose();
    await Promise.race([gracefulClose, this.forceEscalated.then(() => this.forceWorkerShutdown())]);
  }

  private forceWorkerShutdown(): Promise<void> {
    if (this.forcedWorkerShutdown !== undefined) return this.forcedWorkerShutdown;
    this.requestQueue.close();
    this.forcedWorkerShutdown = this.navigationWorker
      .terminate()
      .then(() => this.requestQueue.drain());
    this.resolveForceEscalated();
    return this.forcedWorkerShutdown;
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
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

  private static stoppedResult(): CommandExecutionResult {
    return {
      frames: [
        {
          stream: "stderr",
          bytesBase64: Buffer.from("Cannot answer: daemon navigation was stopped.\n").toString(
            "base64",
          ),
        },
      ],
      exitCode: 1,
    };
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
