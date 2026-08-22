import { CliProgramExecutor } from "../cli-program-executor.js";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  DispatchedCommandResult,
} from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import type { DaemonRecord, DaemonRequest, DaemonResponse } from "./daemon-protocol.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";

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
  private readonly executorFactory: (dependencies: ProgramDependencies) => CommandExecutor;

  constructor(private readonly options: DaemonCommandDispatcherOptions) {
    this.selector = options.selector ?? new InvocationWorkspaceSelector();
    this.daemonEnabled = options.daemonEnabled ?? (() => true);
    this.executorFactory =
      options.executorFactory ?? ((dependencies) => new CliProgramExecutor(dependencies));
  }

  async execute(request: CliExecutionRequest): Promise<DispatchedCommandResult> {
    const selected = this.selector.select(request.argv, request.cwd);
    if (selected.route.kind !== "workspace") return this.executeLocally(request, "cold");
    const workspaceRequest: CliExecutionRequest = { ...request, argv: selected.argv };
    if (!this.daemonEnabled()) return this.executeLocally(workspaceRequest, "cold");
    throw new Error("Workspace daemon dispatch is not available");
  }

  private executeLocally(
    request: CliExecutionRequest,
    mode: "cold" | "fallback",
  ): Promise<DispatchedCommandResult> {
    const executor = this.executorFactory(this.options.createDependencies());
    return executor.execute({ ...request, executionMode: mode }).then((result) => ({ mode, result }));
  }
}
