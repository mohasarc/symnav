import type { BackendRefreshSummary, FileSystem, GitHistory, LanguageBackend } from "@symnav/core";
import type { Clock, Recorder } from "@symnav/telemetry";
import type { TelemetryIdentityProvider } from "./telemetry/telemetry-identity.js";
import type { CommandExecutionMode } from "./command-execution-result.js";
import type { WorkspaceRequestScopeFactory } from "./workspace-request-scope.js";

export interface ProgramDependencies {
  readonly stateDirectory: string;
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
  scopeFactory?: WorkspaceRequestScopeFactory;
}
