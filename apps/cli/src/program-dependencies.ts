import type {
  BackendRefreshSummary,
  FileSystem,
  GitHistory,
  LanguageBackend,
  WorkspaceSession,
} from "@symnav/core";
import type { Clock, Recorder } from "@symnav/telemetry";
import type { DaemonPolicy } from "@symnav/daemon";
import type { TelemetryIdentityProvider } from "./telemetry/telemetry-identity.js";
import type { CommandExecutionMode } from "./command-execution-result.js";

export interface CommandPhaseDurations {
  readonly freshnessMs: number;
  readonly navigationMs: number;
  readonly renderMs: number;
}

export interface ProgramDependencies {
  readonly stateDirectory: string;
  readonly daemonPolicy: DaemonPolicy;
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
