import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { CliProgramExecutor } from "../cli-program-executor.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import { WorkspaceRequestScopeFactory } from "../workspace-request-scope.js";
import type { DaemonRecord, DaemonRequest, DaemonResponse, DaemonServer } from "./daemon-protocol.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "./daemon-protocol.js";
import { NodeDaemonProcessTerminator } from "./daemon-process-launcher.js";
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
  private server: DaemonServer | undefined;
  private startedAt = 0;

  constructor(private readonly options: WorkspaceDaemonOptions) {
    const retainedBackends = options.dependencies.backends();
    const retainedDependencies: ProgramDependencies = {
      ...options.dependencies,
      backends: () => retainedBackends,
    };
    this.scopeFactory = new WorkspaceRequestScopeFactory(options.dependencies.fs, retainedBackends);
    this.executor = options.executor ?? new CliProgramExecutor(retainedDependencies);
    this.now = options.now ?? Date.now;
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  async start(): Promise<void> {
    const startingRecord = await this.waitForStartupAuthorization();
    this.startedAt = startingRecord.startedAt;
    const prepared = await this.scopeFactory.prepare(this.options.identity.workspaceRoot);
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
        setTimeout(() => void this.shutdown(), 0);
      } else {
        setTimeout(() => void this.shutdown(true), 0);
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
      return {
        kind: "result",
        requestId: request.requestId,
        result: await this.requestQueue.enqueue(() => this.executor.execute(request.request)),
      };
    }
    await this.requestQueue.drain();
    setTimeout(() => void this.shutdown(), 0);
    return { kind: "stopped", instanceId: this.options.instanceId };
  }

  private async shutdown(force = false): Promise<void> {
    this.requestQueue.close();
    await this.server?.close(force);
    this.options.registry.removeIfInstance(this.options.identity, this.options.instanceId);
    this.exit(0);
  }
}
