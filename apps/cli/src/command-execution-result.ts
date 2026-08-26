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
  readonly executionMode?: CommandExecutionMode;
}

export class ControlledCommandResult {
  static acceptedRequestDidNotComplete(): CommandExecutionResult {
    return ControlledCommandResult.failure(
      "Cannot answer: accepted daemon request did not complete.\n",
    );
  }

  static workspaceCapacityExceeded(): CommandExecutionResult {
    return ControlledCommandResult.failure("Cannot answer: daemon workspace capacity exceeded.\n");
  }

  static responseCapacityExceeded(): CommandExecutionResult {
    return ControlledCommandResult.failure("Cannot answer: daemon response capacity exceeded.\n");
  }

  private static failure(message: string): CommandExecutionResult {
    return {
      frames: [{ stream: "stderr", bytesBase64: Buffer.from(message).toString("base64") }],
      exitCode: 1,
    };
  }
}
