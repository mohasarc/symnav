import type { DaemonClient, DaemonClientExecuteResult } from "@symnav/daemon";
import type { CliProgramExecutor } from "./cli-program-executor.js";
import type { CliExecutionRequest } from "./command-execution-result.js";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";

export interface CliInvocationCoordinatorOptions {
  readonly daemonClient: DaemonClient;
  readonly createLocalExecutor: () => Pick<CliProgramExecutor, "execute">;
  readonly resolveWorkspaceRoot: (startDirectory: string) => Promise<string>;
}

export class CliInvocationCoordinator {
  private readonly selector = new InvocationWorkspaceSelector();

  constructor(private readonly options: CliInvocationCoordinatorOptions) {}

  async execute(request: CliExecutionRequest): Promise<DaemonClientExecuteResult> {
    const selected = this.selector.select(request.argv, request.cwd);
    if (selected.route.kind !== "workspace") {
      return this.executeLocally(request);
    }
    const workspaceRequest = { ...request, argv: selected.argv };
    let workspaceRoot: string;
    try {
      workspaceRoot = await this.options.resolveWorkspaceRoot(selected.route.startDirectory);
    } catch {
      return this.executeLocally(workspaceRequest);
    }
    return this.options.daemonClient.execute({
      workspaceRoot,
      commandName: selected.route.commandName,
      argv: selected.argv,
      cwd: request.cwd,
      telemetryEnabled: request.telemetryEnabled,
    });
  }

  private async executeLocally(request: CliExecutionRequest): Promise<DaemonClientExecuteResult> {
    const result = await this.options
      .createLocalExecutor()
      .execute({ ...request, executionMode: "cold" });
    return { mode: "cold", result };
  }
}
