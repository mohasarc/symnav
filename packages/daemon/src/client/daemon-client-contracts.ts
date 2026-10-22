import type { DaemonCommandName, DaemonReadinessProbe } from "../daemon-command-name.js";
import type {
  DaemonExecutionMode,
  DaemonExecutorExecutionResult,
  DaemonExecutorFactory,
  DaemonExecutorModuleUrl,
} from "../daemon-executor.js";
import type { DaemonPolicy } from "../daemon-policy.js";

export interface DaemonClientOptions {
  readonly stateDirectory: string;
  readonly productVersion: string;
  readonly daemonEnabled: boolean;
  readonly executorFactory: DaemonExecutorFactory;
  readonly executorModuleUrl: DaemonExecutorModuleUrl;
  readonly readinessProbe: DaemonReadinessProbe;
  readonly policy?: DaemonPolicy;
}

export interface DaemonClientExecuteRequest {
  readonly workspaceRoot: string;
  readonly commandName: DaemonCommandName;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly telemetryEnabled: boolean;
}

export interface DaemonClientExecuteResult {
  readonly mode: DaemonExecutionMode;
  readonly result: DaemonExecutorExecutionResult;
}

export type DaemonControlRequest =
  | { readonly action: "start"; readonly workspaceRoot: string }
  | { readonly action: "status" }
  | { readonly action: "stop"; readonly workspaceRoot: string };
