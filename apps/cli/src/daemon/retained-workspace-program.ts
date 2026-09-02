import type { BackendRefreshSummary, LanguageBackend } from "@symnav/core";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { CliProgramExecutor } from "../cli-program-executor.js";
import type { ProgramDependencies } from "../program-dependencies.js";

export class RetainedWorkspaceProgram {
  readonly backends: readonly LanguageBackend[];
  private readonly executor: CliProgramExecutor;

  constructor(
    dependencies: ProgramDependencies,
    backendRefreshed?: (summary: BackendRefreshSummary) => void,
  ) {
    this.backends = dependencies.backends();
    this.executor = new CliProgramExecutor({
      ...dependencies,
      backends: () => this.backends,
      ...(backendRefreshed === undefined ? {} : { backendRefreshed }),
    });
  }

  execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    return this.executor.execute(request);
  }
}
