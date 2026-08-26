import type { CliExecutionRequest, CommandExecutionResult } from "./command-execution-result.js";
import {
  CommandOutputCapacityError,
  ControlledCommandResult,
  OrderedCommandOutput,
  type OrderedCommandOutputOptions,
} from "./command-execution-result.js";
export { CommandResultReplayer } from "./command-execution-result.js";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { buildProgram } from "./program.js";
import type { WorkspaceRequestScopeFactory } from "./workspace-request-scope.js";

class CapturedProgramExit extends Error {
  constructor(readonly exitCode: number) {
    super();
  }
}

export class CliProgramExecutor {
  constructor(
    private readonly dependencies: ProgramDependencies,
    private readonly scopeFactory?: WorkspaceRequestScopeFactory,
    private readonly outputOptions: OrderedCommandOutputOptions = {},
  ) {}

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    const output = new OrderedCommandOutput(this.outputOptions);
    const context: ProgramContext = {
      stdout: output.stdout,
      stderr: output.stderr,
      cwd: request.cwd,
      exit: (exitCode) => {
        throw new CapturedProgramExit(exitCode);
      },
    };
    const dependencies: ProgramDependencies = {
      ...this.dependencies,
      recorder: this.dependencies.recorder,
      telemetryEnabled: request.telemetryEnabled,
      executionMode: request.executionMode ?? "cold",
      ...(this.scopeFactory === undefined ? {} : { scopeFactory: this.scopeFactory }),
    };

    try {
      await buildProgram(context, dependencies).parseAsync([...request.argv], { from: "user" });
      return await this.finish(output, 0);
    } catch (error) {
      if (error instanceof CapturedProgramExit) return await this.finish(output, error.exitCode);
      if (error instanceof CommandOutputCapacityError) {
        return output.replaceWith(ControlledCommandResult.responseCapacityExceeded());
      }
      await output.dispose();
      throw error;
    }
  }

  private async finish(
    output: OrderedCommandOutput,
    exitCode: number,
  ): Promise<CommandExecutionResult> {
    try {
      return await output.finish(exitCode);
    } catch (error) {
      if (error instanceof CommandOutputCapacityError) {
        return output.replaceWith(ControlledCommandResult.responseCapacityExceeded());
      }
      throw error;
    }
  }
}
