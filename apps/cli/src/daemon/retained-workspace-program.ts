import { type BackendRefreshSummary, WorkspaceSession } from "@symnav/core";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { CliProgramExecutor } from "../cli-program-executor.js";
import type { ProgramDependencies } from "../program-dependencies.js";

export class RetainedWorkspaceProgram {
  readonly workspaceSession: WorkspaceSession;
  private readonly executor: CliProgramExecutor;

  constructor(
    dependencies: ProgramDependencies,
    backendRefreshed?: (summary: BackendRefreshSummary) => void,
  ) {
    const backends = dependencies.backends();
    this.workspaceSession = new WorkspaceSession({
      fileSystem: dependencies.fs,
      backends,
      discoveryRetention: "session",
    });
    this.executor = new CliProgramExecutor(
      {
        ...dependencies,
        backends: () => backends,
        ...(backendRefreshed === undefined ? {} : { backendRefreshed }),
      },
      this.workspaceSession,
    );
  }

  execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    return this.executor.execute(request);
  }
}
