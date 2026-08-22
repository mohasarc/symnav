import type {
  CliExecutionRequest,
  CommandExecutionResult,
} from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import type { DaemonRecord, DaemonRequest, DaemonResponse } from "./daemon-protocol.js";
import type { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";

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
