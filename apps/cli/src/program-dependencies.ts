import type {
  BackendRefreshSummary,
  FileSystem,
  GitHistory,
  LanguageBackend,
  WorkspaceSession,
} from "@symnav/core";
import type { Clock, Recorder, TelemetryFailureObserver } from "@symnav/telemetry";
import type { DaemonClient, DaemonPolicy, DaemonStateWriteFailureObserver } from "@symnav/daemon";
import type { TelemetryIdentityProvider } from "./telemetry/telemetry-identity.js";
import type { InvocationWarningOptions } from "./output/invocation-warning.js";
import type { CommandExecutionMode } from "./command-execution-result.js";

export interface CommandPhaseDurations {
  readonly freshnessMs: number;
  readonly navigationMs: number;
  readonly renderMs: number;
}

export interface ProgramDependencies {
  readonly warningOptions?: InvocationWarningOptions;
  readonly stateDirectory: string;
  readonly stateWriteFailed?: DaemonStateWriteFailureObserver;
  readonly invocationTelemetry?: (
    observer: TelemetryFailureObserver,
  ) => Pick<ProgramDependencies, "recorder" | "identity">;
  readonly daemonPolicy: DaemonPolicy;
  readonly daemonClient: DaemonClient;
  readonly daemonEnabled: boolean;
  fs: FileSystem;
  backends: () => readonly LanguageBackend[];
  git: GitHistory;
  recorder: Recorder;
  clock: Clock;
  telemetryEnabled: boolean;
  executionMode?: CommandExecutionMode;
  identity: TelemetryIdentityProvider;
  symnavVersion: string;
  backendRefreshed?: (summary: BackendRefreshSummary) => void;
  commandPhasesObserved?: (durations: CommandPhaseDurations) => void;
  readonly workspaceSession?: WorkspaceSession;
}
