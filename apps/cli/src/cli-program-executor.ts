import { Writable } from "node:stream";
import type { Recorder, UsageEventInput } from "@symnav/telemetry";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  CommandOutputFrame,
  CommandOutputStream,
} from "./command-execution-result.js";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { buildProgram } from "./program.js";
import type { WorkspaceRequestScopeFactory } from "./workspace-request-scope.js";

class CapturedProgramExit extends Error {
  constructor(readonly exitCode: number) {
    super();
  }
}

class CommandFrameStream extends Writable {
  constructor(
    private readonly stream: CommandOutputStream,
    private readonly frames: CommandOutputFrame[],
  ) {
    super();
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    this.frames.push({ stream: this.stream, bytesBase64: bytes.toString("base64") });
    callback();
  }
}

class DeferredTelemetryRecorder implements Recorder {
  event: UsageEventInput | undefined;

  record(input: UsageEventInput): void {
    this.event = input;
  }
}

export class CliProgramExecutor {
  constructor(
    private readonly dependencies: ProgramDependencies,
    private readonly scopeFactory?: WorkspaceRequestScopeFactory,
  ) {}

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    const frames: CommandOutputFrame[] = [];
    const deferredTelemetry = request.deferTelemetry ? new DeferredTelemetryRecorder() : undefined;
    const context: ProgramContext = {
      stdout: new CommandFrameStream("stdout", frames),
      stderr: new CommandFrameStream("stderr", frames),
      cwd: request.cwd,
      exit: (exitCode) => {
        throw new CapturedProgramExit(exitCode);
      },
    };
    const dependencies: ProgramDependencies = {
      ...this.dependencies,
      recorder: deferredTelemetry ?? this.dependencies.recorder,
      telemetryEnabled: request.telemetryEnabled,
      executionMode: request.executionMode ?? "cold",
      ...(this.scopeFactory === undefined ? {} : { scopeFactory: this.scopeFactory }),
    };

    try {
      await buildProgram(context, dependencies).parseAsync([...request.argv], { from: "user" });
      return CliProgramExecutor.result(frames, 0, deferredTelemetry?.event);
    } catch (error) {
      if (error instanceof CapturedProgramExit) {
        return CliProgramExecutor.result(frames, error.exitCode, deferredTelemetry?.event);
      }
      throw error;
    }
  }

  private static result(
    frames: readonly CommandOutputFrame[],
    exitCode: number,
    telemetry: UsageEventInput | undefined,
  ): CommandExecutionResult {
    return telemetry === undefined ? { frames, exitCode } : { frames, exitCode, telemetry };
  }
}

export class CommandResultReplayer {
  static replay(result: CommandExecutionResult, context: ProgramContext): never | void {
    for (const frame of result.frames) {
      context[frame.stream].write(Buffer.from(frame.bytesBase64, "base64"));
    }
    if (result.exitCode !== 0) {
      context.exit(result.exitCode);
    }
  }
}
