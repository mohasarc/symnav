import type { ProgramDependencies } from "../program-dependencies.js";
import type { CommandExecutionResult } from "../command-execution-result.js";
import type {
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
import type { DaemonRegistry } from "./daemon-registry.js";
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
}

export class WorkspaceDaemon {
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private readonly navigationWorker: DaemonNavigationWorker;
  private readonly requestQueue: WorkspaceRequestQueue;
  private readonly logger: DaemonLogger;
  private readonly lifetime: DaemonLifetime;
  private readonly resourceMonitor: DaemonResourceMonitor;
  private server: DaemonServer | undefined;
  private startedAt = 0;
  private fileCount = 0;
  private lastNavigationAt: number | undefined;
  private workerReady = false;
  private shutdownStarted = false;

  constructor(private readonly options: WorkspaceDaemonOptions) {
    this.now = options.now ?? Date.now;
    this.requestQueue = new WorkspaceRequestQueue(this.now);
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
  }

  async start(): Promise<void> {
    this.logger.record({
      kind: "start",
      workspaceRoot: this.options.identity.workspaceRoot,
      instanceId: this.options.instanceId,
    });
    try {
      const startingRecord = await this.waitForStartupAuthorization();
      this.startedAt = startingRecord.startedAt;
      this.server = await this.options.transport.listen(
        this.options.identity.endpoint(this.options.instanceId),
        (request) => this.handle(request),
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
        await this.server.close();
        throw new Error("Daemon startup ownership changed before readiness publication");
      }
      this.options.registry.removeStartupLockIfProcess(this.options.identity, readyRecord);
      this.logger.record({ kind: "ready", fileCount: response.fileCount });
      this.resourceMonitor.start();
    } catch (error) {
      this.logger.record({
        kind: "failure",
        operation: "start",
        message: WorkspaceDaemon.errorMessage(error),
      });
      throw error;
    }
  }

  private async waitForStartupAuthorization(): Promise<DaemonRecord> {
    const deadline = this.now() + 5_000;
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
        if (record.pid === 0) {
          this.options.registry.writeStartingIfStartupOwner(this.options.identity, {
            ...record,
            pid: process.pid,
          });
        }
        const adoptedRecord = this.options.registry.readInstance(
          this.options.identity,
          this.options.instanceId,
        );
        if (adoptedRecord?.pid !== process.pid) {
          await this.pause();
          continue;
        }
        if (
          !this.options.registry.startupOwnerMatchesProcess(this.options.identity, adoptedRecord)
        ) {
          this.options.registry.writeStartingIfStartupOwner(this.options.identity, adoptedRecord);
        }
        if (
          this.options.registry.startupOwnerMatchesProcess(this.options.identity, adoptedRecord)
        ) {
          return adoptedRecord;
        }
      }
      await this.pause();
    }
    throw new Error("Daemon process did not receive startup authorization");
  }

  private async handle(request: DaemonRequest): Promise<DaemonResponse> {
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
    if (request.kind === "execute") return this.execute(request);
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

  private async execute(
    request: Extract<DaemonRequest, { kind: "execute" }>,
  ): Promise<DaemonResponse> {
    if (!this.workerReady) throw new Error("Daemon navigation worker is still starting");
    this.lastNavigationAt = this.now();
    this.lifetime.navigationAccepted();
    const requestStartedAt = this.now();
    let result: CommandExecutionResult;
    try {
      result = await this.requestQueue.enqueue(
        {
          requestId: request.requestId,
          command: WorkspaceDaemon.commandName(request.request.argv),
          acceptedAt: this.now(),
        },
        async () => {
          const response = await this.navigationWorker.execute(request.requestId, request.request);
          if (response.kind !== "result" || response.requestId !== request.requestId) {
            throw new Error("Navigation worker returned an uncorrelated result");
          }
          this.logger.record({ kind: "freshness", ...response.refresh });
          return response.result;
        },
      );
    } catch (error) {
      this.logger.record({
        kind: "failure",
        operation: "request",
        message: WorkspaceDaemon.errorMessage(error),
      });
      if (!this.shutdownStarted) throw error;
      result = WorkspaceDaemon.stoppedResult();
    } finally {
      if (this.requestQueue.isIdle) this.lifetime.queueBecameIdle();
    }
    this.logger.record({
      kind: "request",
      command: WorkspaceDaemon.commandName(request.request.argv),
      durationMs: Math.max(0, this.now() - requestStartedAt),
      exitCode: result.exitCode,
    });
    if (!(await this.options.dependencies.fs.exists(this.options.identity.workspaceRoot))) {
      setTimeout(() => void this.shutdown("workspace-deleted"), 0);
    }
    return { kind: "result", requestId: request.requestId, result };
  }

  private async drainAndShutdown(reason: "idle"): Promise<void> {
    await this.requestQueue.drain();
    await this.shutdown(reason);
  }

  private async shutdown(
    reason: "graceful" | "idle" | "resource" | "workspace-deleted",
    force = false,
  ): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    this.lifetime.stop();
    this.resourceMonitor.stop();
    if (force) {
      this.requestQueue.close();
      await this.navigationWorker.terminate();
      await this.requestQueue.drain();
    } else {
      await this.requestQueue.drain();
      await this.navigationWorker.drainAndClose();
    }
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
