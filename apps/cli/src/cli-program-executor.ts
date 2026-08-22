import type { CliExecutionRequest, CommandExecutionResult } from "./command-execution-result.js";
import type { ProgramDependencies } from "./program-dependencies.js";

export class CliProgramExecutor {
  constructor(private readonly _dependencies: ProgramDependencies) {}

  execute(_request: CliExecutionRequest): Promise<CommandExecutionResult> {
    throw new Error("Captured CLI execution is not implemented");
  }
}
