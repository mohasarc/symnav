import { join } from "node:path";
import type { CliExecutionRequest, CommandExecutionResult } from "./command-execution-result.js";
import type { WorkspaceSession } from "@symnav/core";
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
import { InvocationStateWriteCoordinator } from "./state/state-write-coordinator.js";
import { InvocationStateDependencies } from "./state/invocation-state-dependencies.js";

class CapturedProgramExit extends Error {
  constructor(readonly exitCode: number) {
    super();
  }
}

export class CliProgramExecutor {
  constructor(
    private readonly dependencies: ProgramDependencies,
    private readonly workspaceSession?: WorkspaceSession,
  ) {}

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    const state = new InvocationStateWriteCoordinator(this.dependencies.stateDirectory);
    const output = new OrderedCommandOutput({
      policy: this.dependencies.daemonPolicy.values.output,
      directory: join(this.dependencies.stateDirectory, "captures"),
      stateWriteFailed: (path, error) => state.failed(path, error),
    });
    const context: ProgramContext = {
      stdout: output.stdout,
      stderr: output.stderr,
      cwd: request.cwd,
      exit: (exitCode) => {
        throw new CapturedProgramExit(exitCode);
      },
    };
    const dependencies: ProgramDependencies = {
      ...InvocationStateDependencies.create(this.dependencies, state, request.telemetryEnabled),
      executionMode: request.executionMode ?? "cold",
      ...(this.workspaceSession === undefined ? {} : { workspaceSession: this.workspaceSession }),
    };

    try {
      await buildProgram(context, dependencies).parseAsync([...request.argv], { from: "user" });
      return this.withStateFailure(await this.finish(output, 0, state), state);
    } catch (error) {
      if (error instanceof CapturedProgramExit)
        return this.withStateFailure(await this.finish(output, error.exitCode, state), state);
      if (error instanceof CommandOutputCapacityError) {
        return output.replaceWith(ControlledCommandResult.responseCapacityExceeded());
      }
      if (state.access.kind === "disabled") return this.failedCapture(output, state);
      await output.dispose();
      throw error;
    }
  }

  private withStateFailure(
    result: CommandExecutionResult,
    state: InvocationStateWriteCoordinator,
  ): CommandExecutionResult {
    if (state.access.kind !== "disabled") return result;
    const { operationPath: path, osCode } = state.access.failure;
    return { ...result, stateWriteFailure: { path, ...(osCode === undefined ? {} : { osCode }) } };
  }

  private async finish(
    output: OrderedCommandOutput,
    exitCode: number,
    state: InvocationStateWriteCoordinator,
  ): Promise<CommandExecutionResult> {
    try {
      return await output.finish(exitCode);
    } catch (error) {
      if (error instanceof CommandOutputCapacityError) {
        return output.replaceWith(ControlledCommandResult.responseCapacityExceeded());
      }
      if (state.access.kind === "disabled") return this.failedCapture(output, state);
      throw error;
    }
  }

  private async failedCapture(
    output: OrderedCommandOutput,
    state: InvocationStateWriteCoordinator,
  ): Promise<CommandExecutionResult> {
    await output.dispose().catch(() => undefined);
    return this.withStateFailure(ControlledCommandResult.acceptedRequestDidNotComplete(), state);
  }
}
