import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { CliInvocationCoordinator } from "./cli-invocation-coordinator.js";
import type { CliExecutionRequest } from "./command-execution-result.js";
import {
  CommandOutputSnapshot,
  CommandResultReplayer,
  ControlledCommandResult,
  type CommandOutputRecord,
  type CommandOutputStream,
  type CommandExecutionResult,
} from "./command-execution-result.js";
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

class DirectCommandOutput {
  private bytes = 0;
  private exceeded = false;
  private readonly records: Omit<CommandOutputRecord, "sequence">[] = [];

  public constructor(private readonly maximumBytes: number) {}

  public append(stream: CommandOutputStream, bytes: Buffer): void {
    if (this.exceeded || bytes.byteLength === 0) return;
    if (this.bytes + bytes.byteLength > this.maximumBytes) {
      this.exceeded = true;
      this.records.length = 0;
      return;
    }
    this.bytes += bytes.byteLength;
    this.records.push({ stream, bytes: Buffer.from(bytes) });
  }

  public finish(exitCode: number): CommandExecutionResult {
    if (this.exceeded) return ControlledCommandResult.responseCapacityExceeded();
    return { output: new CommandOutputSnapshot(this.records), exitCode };
  }
}

class DirectCommandWritable extends Writable {
  public constructor(
    private readonly stream: CommandOutputStream,
    private readonly output: DirectCommandOutput,
  ) {
    super();
  }

  public override _write(
    bytes: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output.append(this.stream, bytes);
    callback();
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
    const output = new DirectCommandOutput(
      this.options.dependencies.daemonPolicy.values.output.maximumResultRawBytes,
    );
    const stdout = new DirectCommandWritable("stdout", output);
    const stderr = new DirectCommandWritable("stderr", output);
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
    const result = output.finish(exitCode);
    await CommandResultReplayer.replay(result, {
      ...context,
      exit: () => undefined as never,
    });
    return result.exitCode;
  }
}
