export type CommandOutputStream = "stdout" | "stderr";

export interface CommandOutputFrame {
  readonly stream: CommandOutputStream;
  readonly bytesBase64: string;
}

export interface CommandExecutionResult {
  readonly frames: readonly CommandOutputFrame[];
  readonly exitCode: number;
}

export type CommandExecutionMode = "cold" | "warm" | "fallback";

export interface DispatchedCommandResult {
  readonly mode: CommandExecutionMode;
  readonly result: CommandExecutionResult;
}

export interface CliExecutionRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly telemetryEnabled: boolean;
}
