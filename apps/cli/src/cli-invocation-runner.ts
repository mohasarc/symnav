import { Writable } from "node:stream";
import { inspect } from "node:util";
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
import type { DaemonExecutorOutput } from "@symnav/daemon";
import { InvocationStateWriteCoordinator } from "./state/state-write-coordinator.js";
import { InvocationStateDependencies } from "./state/invocation-state-dependencies.js";

export interface CliInvocationRunnerOptions {
  readonly dependencies: ProgramDependencies;
  readonly coordinator: CliInvocationCoordinator;
}

class StateObservedCommandOutput implements DaemonExecutorOutput {
  public constructor(
    private readonly output: DaemonExecutorOutput,
    private readonly state: InvocationStateWriteCoordinator,
  ) {}

  public records() {
    return this.output.records();
  }

  public async dispose(): Promise<void> {
    try {
      await this.output.dispose();
    } catch (error) {
      if (typeof error !== "object" || error === null) throw error;
      const failure = error as NodeJS.ErrnoException;
      if (
        typeof failure.path !== "string" ||
        !/^(unlink|rmdir|rename)/u.test(failure.syscall ?? "")
      )
        throw error;
      this.state.failed(failure.path, failure);
    }
  }
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
    const state = new InvocationStateWriteCoordinator(this.options.dependencies.stateDirectory);
    const route = new InvocationWorkspaceSelector().classify(request.argv, request.cwd);
    const daemonEligible =
      route.kind === "workspace" && (route.commandName !== "stats" || request.telemetryEnabled);
    await state.prepare({
      daemon: daemonEligible && this.options.dependencies.daemonEnabled,
      telemetry: route.kind === "workspace" && request.telemetryEnabled,
    });
    const dependencies = InvocationStateDependencies.create(
      this.options.dependencies,
      state,
      request.telemetryEnabled,
    );
    const local = (mode: "cold" | "fallback") =>
      this.executeLocally({ ...request, executionMode: mode }, dependencies, state);
    const result =
      state.access.kind === "disabled" || !dependencies.daemonEnabled || !daemonEligible
        ? await local("cold")
        : (
            await this.options.coordinator.execute({
              ...request,
              stateWriteFailed: (failure) =>
                state.failed(
                  failure.path,
                  failure.osCode === undefined ? undefined : { code: failure.osCode },
                ),
              executeLocally: local,
            })
          ).result;
    if (result.stateWriteFailure !== undefined) {
      const failure = result.stateWriteFailure;
      state.failed(
        failure.path,
        failure.osCode === undefined ? undefined : { code: failure.osCode },
      );
    }
    const replayContext: ProgramContext = { ...context, exit: () => undefined as never };
    await CommandResultReplayer.replay(
      { ...result, output: new StateObservedCommandOutput(result.output, state) },
      replayContext,
    );
    const warning = state.renderWarning();
    if (warning !== undefined) {
      await CommandResultReplayer.replay(
        {
          exitCode: 0,
          output: new CommandOutputSnapshot([{ stream: "stderr", bytes: Buffer.from(warning) }]),
        },
        replayContext,
      );
    }
    return result.exitCode;
  }

  private async executeLocally(
    request: CliExecutionRequest,
    dependencies: ProgramDependencies,
    state: InvocationStateWriteCoordinator,
  ): Promise<CommandExecutionResult> {
    const output = new DirectCommandOutput(
      dependencies.daemonPolicy.values.output.maximumResultRawBytes,
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
          ...dependencies,
          executionMode: request.executionMode ?? "cold",
        },
      );
      const selected = new InvocationWorkspaceSelector().select(request.argv, request.cwd);
      await program.parseAsync([...selected.argv], { from: "user" });
    } catch (error) {
      if (error instanceof DirectProgramExit) exitCode = error.exitCode;
      else if (state.access.kind === "disabled") {
        stderr.write(`${inspect(error)}\n`);
        exitCode = 1;
      } else throw error;
    } finally {
      stdout.end();
      stderr.end();
      await completion;
    }
    return output.finish(exitCode);
  }
}
