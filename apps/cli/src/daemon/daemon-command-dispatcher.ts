import { randomUUID } from "node:crypto";
import { createWorkspace } from "@symnav/core";
import { CliProgramExecutor } from "../cli-program-executor.js";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  DispatchedCommandResult,
} from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import type { DaemonRecord, DaemonRequest, DaemonResponse } from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { NodeDaemonProcessLauncher } from "./daemon-process-launcher.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

interface DaemonStarter {
  ensureRunning(identity: DaemonWorkspaceIdentity): Promise<unknown>;
}

interface DaemonDispatchRegistry {
  read(identity: DaemonWorkspaceIdentity): DaemonRecord | undefined;
  removeIfInstance(identity: DaemonWorkspaceIdentity, instanceId: string): void;
}

interface DaemonDispatchTransport {
  request(endpoint: string, request: DaemonRequest): Promise<DaemonResponse>;
}

export interface DaemonDispatchRuntime {
  readonly coordinator: DaemonStarter;
  readonly registry: DaemonDispatchRegistry;
  readonly transport: DaemonDispatchTransport;
}

interface CommandExecutor {
  execute(request: CliExecutionRequest): Promise<CommandExecutionResult>;
}

export interface DaemonCommandDispatcherOptions {
  readonly createDependencies: () => ProgramDependencies;
  readonly stateDirectory: string;
  readonly daemonEnabled?: () => boolean;
  readonly selector?: InvocationWorkspaceSelector;
  readonly resolveWorkspaceRoot?: (
    startDir: string,
    dependencies: ProgramDependencies,
  ) => Promise<string>;
  readonly runtimeFactory?: (
    identity: DaemonWorkspaceIdentity,
    dependencies: ProgramDependencies,
  ) => DaemonDispatchRuntime;
  readonly executorFactory?: (dependencies: ProgramDependencies) => CommandExecutor;
  readonly requestId?: () => string;
}

export class DaemonCommandDispatcher {
  private readonly selector: InvocationWorkspaceSelector;
  private readonly daemonEnabled: () => boolean;
  private readonly resolveWorkspaceRoot: (
    startDir: string,
    dependencies: ProgramDependencies,
  ) => Promise<string>;
  private readonly runtimeFactory: (
    identity: DaemonWorkspaceIdentity,
    dependencies: ProgramDependencies,
  ) => DaemonDispatchRuntime;
  private readonly executorFactory: (dependencies: ProgramDependencies) => CommandExecutor;
  private readonly requestId: () => string;

  constructor(private readonly options: DaemonCommandDispatcherOptions) {
    this.selector = options.selector ?? new InvocationWorkspaceSelector();
    this.daemonEnabled = options.daemonEnabled ?? (() => true);
    this.resolveWorkspaceRoot =
      options.resolveWorkspaceRoot ??
      (async (startDir, dependencies) =>
        (await createWorkspace({ startDir, fs: dependencies.fs })).root);
    this.runtimeFactory = options.runtimeFactory ?? DaemonCommandDispatcher.createRuntime;
    this.executorFactory =
      options.executorFactory ?? ((dependencies) => new CliProgramExecutor(dependencies));
    this.requestId = options.requestId ?? randomUUID;
  }

  async execute(request: CliExecutionRequest): Promise<DispatchedCommandResult> {
    const selected = this.selector.select(request.argv, request.cwd);
    if (selected.route.kind !== "workspace") return this.executeLocally(request, "cold");
    const workspaceRequest: CliExecutionRequest = { ...request, argv: selected.argv };
    if (!this.daemonEnabled()) return this.executeLocally(workspaceRequest, "cold");

    const dependencies = this.options.createDependencies();
    const workspaceRoot = await this.resolveWorkspaceRoot(selected.route.startDir, dependencies);
    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.options.stateDirectory);
    const runtime = this.runtimeFactory(identity, dependencies);
    let record = runtime.registry.read(identity);
    if (DaemonCommandDispatcher.requiresStartup(record, dependencies)) {
      try {
        await runtime.coordinator.ensureRunning(identity);
        record = runtime.registry.read(identity);
      } catch {
        return this.executeLocally(workspaceRequest, "fallback");
      }
    }
    if (record?.state !== "ready") throw new Error("Daemon did not publish a ready record");
    let response: DaemonResponse;
    try {
      response = await runtime.transport.request(record.endpoint, {
        kind: "execute",
        protocolVersion: record.protocolVersion,
        instanceId: record.instanceId,
        requestId: this.requestId(),
        request: { ...workspaceRequest, executionMode: "warm" },
      });
    } catch {
      await this.invalidate(runtime, identity, record);
      return this.executeLocally(workspaceRequest, "fallback");
    }
    if (response.kind !== "result") throw new Error("Daemon returned no command result");
    return { mode: "warm", result: response.result };
  }

  private executeLocally(
    request: CliExecutionRequest,
    mode: "cold" | "fallback",
  ): Promise<DispatchedCommandResult> {
    const executor = this.executorFactory(this.options.createDependencies());
    return executor.execute({ ...request, executionMode: mode }).then((result) => ({ mode, result }));
  }

  private async invalidate(
    runtime: DaemonDispatchRuntime,
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
  ): Promise<void> {
    await runtime.transport.request(record.endpoint, {
      kind: "kill",
      instanceId: record.instanceId,
      processToken: record.processToken,
    });
    runtime.registry.removeIfInstance(identity, record.instanceId);
  }

  private static createRuntime(
    identity: DaemonWorkspaceIdentity,
    dependencies: ProgramDependencies,
  ): DaemonDispatchRuntime {
    const registry = new DaemonRegistry(identity.registryDirectory);
    const transport = new LocalDaemonTransport();
    return {
      registry,
      transport,
      coordinator: new DaemonStartupCoordinator(
        registry,
        new NodeDaemonProcessLauncher(dependencies.symnavVersion),
        transport,
      ),
    };
  }

  private static requiresStartup(
    record: DaemonRecord | undefined,
    dependencies: ProgramDependencies,
  ): boolean {
    return (
      record === undefined ||
      record.state === "starting" ||
      record.symnavVersion !== dependencies.symnavVersion
    );
  }
}
