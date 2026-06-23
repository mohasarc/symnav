import type { FileSystem, GitHistory, LanguageBackend } from "@symnav/core";
import type { Clock, Recorder } from "@symnav/telemetry";
import type { TelemetryIdentityProvider } from "./telemetry/telemetry-identity.js";

export interface ProgramDependencies {
  fs: FileSystem;
  backends: () => readonly LanguageBackend[];
  git: GitHistory;
  recorder: Recorder;
  clock: Clock;
  telemetryEnabled: boolean;
  identity: TelemetryIdentityProvider;
  symnavVersion: string;
}
