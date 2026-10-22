import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { CliInvocationCoordinator } from "./cli-invocation-coordinator.js";
import type { CliExecutionRequest } from "./command-execution-result.js";
import { CommandResultReplayer } from "./command-execution-result.js";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";
import { buildProgram } from "./program.js";

export interface CliInvocationRunnerOptions {
  readonly dependencies: ProgramDependencies;
  readonly coordinator: CliInvocationCoordinator;
}

class DirectProgramExit extends Error {
  public constructor(public readonly exitCode: number) {
    super();
  }
}

class DirectCommandWritable extends Writable {
  public constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }

  public override _write(
    bytes: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.target.write(bytes, callback);
  }
}

export class CliInvocationRunner {
  public constructor(private readonly options: CliInvocationRunnerOptions) {}

  public async run(request: CliExecutionRequest, context: ProgramContext): Promise<number> {
    if (!this.options.dependencies.daemonEnabled) return this.runLocally(request, context);
    const execution = await this.options.coordinator.execute(request);
    await CommandResultReplayer.replay(execution.result, {
      ...context,
      exit: () => undefined as never,
    });
    return execution.result.exitCode;
  }

  private async runLocally(request: CliExecutionRequest, context: ProgramContext): Promise<number> {
    const stdout = new DirectCommandWritable(context.stdout);
    const stderr = new DirectCommandWritable(context.stderr);
    const completion = Promise.all([finished(stdout), finished(stderr)]);
    let exitCode = 0;
    try {
      const program = buildProgram(
        {
          stdout,
          stderr,
          cwd: request.cwd,
          exit: (code) => {
            throw new DirectProgramExit(code);
          },
        },
        {
          ...this.options.dependencies,
          telemetryEnabled: request.telemetryEnabled,
          executionMode: "cold",
        },
      );
      const selected = new InvocationWorkspaceSelector().select(request.argv, request.cwd);
      await program.parseAsync([...selected.argv], { from: "user" });
    } catch (error) {
      if (error instanceof DirectProgramExit) exitCode = error.exitCode;
      else throw error;
    } finally {
      stdout.end();
      stderr.end();
      await completion;
    }
    return exitCode;
  }
}
