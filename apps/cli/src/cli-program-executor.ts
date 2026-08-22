import { Writable } from "node:stream";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  CommandOutputFrame,
  CommandOutputStream,
} from "./command-execution-result.js";
import type { ProgramContext } from "./program-context.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { buildProgram } from "./program.js";

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

export class CliProgramExecutor {
  constructor(private readonly dependencies: ProgramDependencies) {}

  async execute(request: CliExecutionRequest): Promise<CommandExecutionResult> {
    const frames: CommandOutputFrame[] = [];
    const context: ProgramContext = {
      stdout: new CommandFrameStream("stdout", frames),
      stderr: new CommandFrameStream("stderr", frames),
      cwd: request.cwd,
      exit: (exitCode) => {
        throw new CapturedProgramExit(exitCode);
      },
    };
    const dependencies = {
      ...this.dependencies,
      telemetryEnabled: request.telemetryEnabled,
    };

    try {
      await buildProgram(context, dependencies).parseAsync([...request.argv], { from: "user" });
      return { frames, exitCode: 0 };
    } catch (error) {
      if (error instanceof CapturedProgramExit) {
        return { frames, exitCode: error.exitCode };
      }
      throw error;
    }
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
