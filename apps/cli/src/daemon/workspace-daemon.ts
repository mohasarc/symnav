import type { ProgramDependencies } from "../program-dependencies.js";
import { CliProgramExecutor } from "../cli-program-executor.js";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { WorkspaceRequestScopeFactory } from "../workspace-request-scope.js";
import type {
  DaemonRecord,
  DaemonRequest,
  DaemonResponse,
  DaemonServer,
} from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import { NodeDaemonProcessTerminator } from "./daemon-process-launcher.js";
import { DAEMON_IDLE_TIMEOUT_MS, DaemonLifetime } from "./daemon-lifetime.js";
import { DaemonLogger } from "./daemon-logger.js";
import { DaemonResourceMonitor } from "./daemon-resource-monitor.js";
import type { DaemonRegistry } from "./daemon-registry.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { LocalDaemonTransport } from "./local-daemon-transport.js";
import { WorkspaceRequestQueue } from "./workspace-request-queue.js";

export interface WorkspaceDaemonOptions {
  readonly identity: DaemonWorkspaceIdentity;
  readonly instanceId: string;
  readonly processToken: string;
  readonly symnavVersion: string;
  readonly memoryCapBytes: number;
  readonly dependencies: ProgramDependencies;
  readonly registry: DaemonRegistry;
  readonly transport: LocalDaemonTransport;
  readonly now?: () => number;
  readonly exit?: (code: number) => void;
  readonly executor?: DaemonCommandExecutor;
  readonly idleTimeoutMs?: number;
  readonly resourceCheckIntervalMs?: number;
  readonly residentMemoryBytes?: () => number;
}

export interface DaemonCommandExecutor {
  execute(request: CliExecutionRequest): Promise<CommandExecutionResult>;
}

export class WorkspaceDaemon {
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private readonly executor: DaemonCommandExecutor;
  private readonly scopeFactory: WorkspaceRequestScopeFactory;
  private readonly requestQueue = new WorkspaceRequestQueue();
  private readonly logger: DaemonLogger;
  private readonly lifetime: DaemonLifetime;
  private readonly resourceMonitor: DaemonResourceMonitor;
  private server: DaemonServer | undefined;
  private startedAt = 0;
  private shutdownStarted = false;

  constructor(private readonly options: WorkspaceDaemonOptions) {
    const retainedBackends = options.dependencies.backends();
    const retainedDependencies: ProgramDependencies = {
      ...options.dependencies,
      backends: () => retainedBackends,
      backendRefreshed: (summary) => {
        options.dependencies.backendRefreshed?.(summary);
        this.logger.record({ kind: "freshness", ...summary });
      },
    };
    this.now = options.now ?? Date.now;
    this.logger = new DaemonLogger(options.identity.logPath, { now: this.now });
    this.executor = options.executor ?? new CliProgramExecutor(retainedDependencies);
    this.scopeFactory = new WorkspaceRequestScopeFactory(options.dependencies.fs, retainedBackends);
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
      const prepared = await this.scopeFactory.prepare(this.options.identity.workspaceRoot);
      this.logger.record({ kind: "freshness", ...prepared.refresh });
      this.server = await this.options.transport.listen(
        this.options.identity.endpoint(this.options.instanceId),
        (request) => this.handle(request),
      );
      const fileCount = prepared.refresh.added + prepared.refresh.unchanged;
      const readyRecord: DaemonRecord = {
        schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        symnavVersion: this.options.symnavVersion,
        workspaceRoot: this.options.identity.workspaceRoot,
        workspaceKey: this.options.identity.workspaceKey,
        instanceId: this.options.instanceId,
        processToken: this.options.processToken,
        endpoint: this.options.identity.endpoint(this.options.instanceId),
        pid: process.pid,
        state: "ready",
        startedAt: startingRecord.startedAt,
        readyAt: this.now(),
        fileCount,
        memoryCapBytes: this.options.memoryCapBytes,
      };
      if (!this.options.registry.writeIfStartupOwner(this.options.identity, readyRecord)) {
        await this.server.close();
        throw new Error("Daemon startup ownership changed before readiness publication");
      }
      this.logger.record({ kind: "ready", fileCount });
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
    const terminator = new NodeDaemonProcessTerminator();
    const deadline = this.now() + 5_000;
    while (this.now() <= deadline) {
      const owner = this.options.registry.startupOwner(this.options.identity);
      const record = this.options.registry.readInstance(
        this.options.identity,
        this.options.instanceId,
      );
      if (
        owner?.instanceId === this.options.instanceId &&
        terminator.isAlive(owner.ownerPid) &&
        record?.state === "starting" &&
        record.pid === process.pid
      ) {
        return record;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Daemon process did not receive startup authorization");
  }

  private async handle(request: DaemonRequest): Promise<DaemonResponse> {
    if (request.kind === "identify") {
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
    if (request.kind === "terminate" || request.kind === "kill") {
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
    if (
      request.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
      request.instanceId !== this.options.instanceId
    )
      throw new Error("Daemon request does not match protocol or instance");
    if (request.kind === "ping") {
      return {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: this.options.instanceId,
        symnavVersion: this.options.symnavVersion,
      };
    }
    if (request.kind === "execute") {
      this.lifetime.navigationAccepted();
      const requestStartedAt = this.now();
      let result;
      try {
        result = await this.requestQueue.enqueue(() => this.executor.execute(request.request));
      } catch (error) {
        this.logger.record({
          kind: "failure",
          operation: "request",
          message: WorkspaceDaemon.errorMessage(error),
        });
        throw error;
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
      return {
        kind: "result",
        requestId: request.requestId,
        result,
      };
    }
    await this.requestQueue.drain();
    setTimeout(() => void this.shutdown("graceful"), 0);
    return { kind: "stopped", instanceId: this.options.instanceId };
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
    this.requestQueue.close();
    this.logger.record({ kind: "stop", reason });
    await this.server?.close(force);
    this.options.registry.removeIfInstance(this.options.identity, this.options.instanceId);
    this.exit(0);
  }

  private static commandName(argv: readonly string[]): string {
    const commands = ["overview", "resolve", "def", "refs", "context", "graph", "stats"];
    const command = argv.find((argument) => commands.includes(argument));
    if (command !== undefined) return command;
    if (argv.includes("--version") || argv.includes("-v")) return "version";
    if (argv.includes("--help") || argv.includes("-h")) return "help";
    return "unknown";
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
