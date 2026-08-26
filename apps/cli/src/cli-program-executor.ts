import type { CliExecutionRequest, CommandExecutionResult } from "./command-execution-result.js";
import { OrderedCommandOutput } from "./command-execution-result.js";
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
  ) {}

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    const output = new OrderedCommandOutput();
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
      return await output.finish(0);
    } catch (error) {
      if (error instanceof CapturedProgramExit) return await output.finish(error.exitCode);
      await output.dispose();
      throw error;
    }
  }
}
