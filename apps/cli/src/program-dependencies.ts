import type { FileSystem, GitHistory, LanguageBackend } from "@symnav/core";
import type { Clock, Recorder } from "@symnav/telemetry";
import type { TelemetryIdentityProvider } from "./telemetry/telemetry-identity.js";
import type { CommandExecutionMode } from "./command-execution-result.js";

export interface ProgramDependencies {
  fs: FileSystem;
  backends: () => readonly LanguageBackend[];
  git: GitHistory;
  recorder: Recorder;
  clock: Clock;
  telemetryEnabled: boolean;
  executionMode?: CommandExecutionMode;
  identity: TelemetryIdentityProvider;
  symnavVersion: string;
}
