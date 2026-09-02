import { type BackendRefreshSummary, type LanguageBackend, WorkspaceCatalog } from "@symnav/core";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import { CliProgramExecutor } from "../cli-program-executor.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import { WorkspaceRequestScopeFactory } from "../workspace-request-scope.js";

export class RetainedWorkspaceProgram {
  readonly backends: readonly LanguageBackend[];
  readonly scopeFactory: WorkspaceRequestScopeFactory;
  private readonly executor: CliProgramExecutor;

  constructor(
    dependencies: ProgramDependencies,
    backendRefreshed?: (summary: BackendRefreshSummary) => void,
  ) {
    this.backends = dependencies.backends();
    this.scopeFactory = new WorkspaceRequestScopeFactory(
      dependencies.fs,
      this.backends,
      new WorkspaceCatalog(dependencies.fs),
    );
    this.executor = new CliProgramExecutor(
      {
        ...dependencies,
        backends: () => this.backends,
        ...(backendRefreshed === undefined ? {} : { backendRefreshed }),
      },
      this.scopeFactory,
    );
  }

  execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    return this.executor.execute(request);
  }
}
