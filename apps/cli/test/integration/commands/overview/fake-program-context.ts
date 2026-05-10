import { Writable } from "node:stream";
import type { ProgramContext } from "../../../../src/program-context.js";

export class BufferStream extends Writable {
  private chunks: string[] = [];

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (typeof chunk === "string") {
      this.chunks.push(chunk);
    } else if (Buffer.isBuffer(chunk)) {
      this.chunks.push(chunk.toString("utf8"));
    } else {
      this.chunks.push(String(chunk));
    }
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

export interface FakeProgramContext extends ProgramContext {
  stdout: BufferStream;
  stderr: BufferStream;
  readonly exitCodes: readonly number[];
}

export function createFakeProgramContext(args: { cwd: string }): FakeProgramContext {
  const stdout = new BufferStream();
  const stderr = new BufferStream();
  const exitCodes: number[] = [];
  const exit = ((code: number): never => {
    exitCodes.push(code);
    return undefined as never;
  }) as ProgramContext["exit"];
  return {
    stdout,
    stderr,
    cwd: args.cwd,
    exit,
    exitCodes,
  };
}
